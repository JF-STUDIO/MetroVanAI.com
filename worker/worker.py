import os
import time
import json
import shutil
from pathlib import Path

from dotenv import load_dotenv
from PIL import Image
import imageio.v2 as imageio
import requests
from supabase import create_client, Client

from .raw_decoder import is_camera_raw_suffix, decode_camera_raw_to_jpg

# 从项目根目录加载 .env（如果存在）
load_dotenv(dotenv_path=Path(__file__).resolve().parents[1] / ".env")

# ===== 配置区 =====
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

IMAGES_BUCKET = "images"
DOWNLOAD_DIR = Path("/tmp/jobs")
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
COMFY_INPUT_DIR = Path(os.environ.get("COMFY_INPUT_DIR", "/workspace/runpod-slim/ComfyUI/input"))
COMFY_OUTPUT_DIR = Path(os.environ.get("COMFY_OUTPUT_DIR", "/workspace/runpod-slim/ComfyUI/output"))

# ComfyUI workflow 配置：可以通过环境变量 COMFY_WORKFLOW_PATH 覆盖默认路径
DEFAULT_WORKFLOW_PATH = Path(__file__).parent / "comfy_workflow.json"
WORKFLOW_PATH = Path(os.environ.get("COMFY_WORKFLOW_PATH", DEFAULT_WORKFLOW_PATH))

if not WORKFLOW_PATH.is_file():
    raise FileNotFoundError(
        f"ComfyUI workflow JSON 不存在: {WORKFLOW_PATH}. "
        "请导出一个 workflow.json（包含 LoadImage 节点 31 和 SaveImage 节点 41）并放到该路径，"
        "或者设置环境变量 COMFY_WORKFLOW_PATH 指向实际的 JSON 文件。"
    )

with WORKFLOW_PATH.open("r", encoding="utf-8") as f:
    BASE_WORKFLOW = json.load(f)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
# ===== 结束配置区 =====


def log(msg: str) -> None:
    print(msg, flush=True)


def fetch_next_job():
    """拿一条 status = 'uploaded' 的任务，并把它抢占为 processing。"""
    res = (
        supabase.table("jobs")
        .select("*")
        .eq("status", "uploaded")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    data = res.data or []
    if not data:
        return None

    job = data[0]
    job_id = job["id"]

    # 尝试把这一条标记为 processing（前提还是 uploaded）
    update_res = (
        supabase.table("jobs")
        .update({"status": "processing"})
        .eq("id", job_id)
        .eq("status", "uploaded")
        .execute()
    )
    if not update_res.data:
        # 说明被其他 worker 抢先改了
        return None

    return job


def download_input(job) -> Path:
    """从 Storage 下载原始图片到本地临时目录。

    如果是 RAW 等非 JPG/PNG 格式，强制转换为 JPG，后续统一用 JPG 交给 Comfy 处理。
    原始文件仍然保留在 Supabase Storage 中（只删除本地临时 RAW 文件）。
    """
    input_path = job["input_path"]
    log(f"Downloading {input_path} ...")
    file_bytes = supabase.storage.from_(IMAGES_BUCKET).download(input_path)

    suffix = Path(input_path).suffix.lower()
    local_path = DOWNLOAD_DIR / f"input-{job['id']}{suffix}"
    local_path.write_bytes(file_bytes)

    # 1) 如果是 PNG，直接使用原文件
    if suffix == ".png":
        return local_path

    # 2) 如果是相机 RAW，交给 raw_decoder 组件解码为 JPG
    if is_camera_raw_suffix(suffix):
        try:
            jpg_path = decode_camera_raw_to_jpg(local_path, DOWNLOAD_DIR)
            log(f"Converted camera RAW {local_path} -> {jpg_path} via rawpy/LibRaw")
            try:
                local_path.unlink()
            except Exception:
                pass
            return jpg_path
        except Exception as e:
            # 抛给上层，由 main_loop 标记任务失败
            raise RuntimeError(f"相机 RAW 解码失败: {e}")

    # 3) 其它格式（包括 JPG/JPEG）：尝试用 Pillow 转成 PNG
    png_path = DOWNLOAD_DIR / f"input-{job['id']}.png"
    try:
        img = Image.open(local_path)
        rgb = img.convert("RGB")
        rgb.save(png_path, "PNG")
        log(f"Converted image {local_path} -> {png_path} via Pillow")
        try:
            local_path.unlink()
        except Exception:
            pass
        return png_path
    except Exception as e:
        # 无法转换时抛出异常，由上层统一标记任务失败
        raise RuntimeError(f"RAW/图片 转 PNG 失败: {e}")


def submit_to_comfy(prompt: dict) -> str:
    """提交 workflow 给 Comfy，返回 prompt_id。"""
    resp = requests.post(f"{COMFY_URL}/prompt", json={"prompt": prompt})
    resp.raise_for_status()
    data = resp.json()
    return data["prompt_id"]


def wait_for_file(path: Path, timeout: int = 600) -> None:
    """等待输出文件出现。"""
    start = time.time()
    while time.time() - start < timeout:
        if path.exists() and path.stat().st_size > 0:
            return
        time.sleep(2)
    raise TimeoutError(f"等待输出文件超时: {path}")


def process_image(local_input: Path) -> Path:
    """
    真正的修图逻辑：把本地图片交给 Comfy 处理，然后返回输出文件路径。
    """

    # 1) 把下载好的图片复制到 Comfy 的 input 目录
    COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    input_name = local_input.name  # 例如 input-xxxx.jpg
    comfy_input_path = COMFY_INPUT_DIR / input_name
    shutil.copy2(local_input, comfy_input_path)

    # 2) 基于基础 workflow 生成一个新的 prompt
    workflow = json.loads(json.dumps(BASE_WORKFLOW))  # 深拷贝

    # 修改 LoadImage 节点（31）的 image 字段为我们刚复制的文件名
    # 确保 comfy_workflow.json 里有 "31": { "class_type": "LoadImage", ... }
    load_node = workflow["31"]["inputs"]
    load_node["image"] = input_name

    # 3) 为输出生成一个唯一文件名（不带扩展名）
    out_stem = local_input.stem + "_edited"

    # 修改 SaveImagePlusV2 节点（41），使用自定义文件名和 png 格式
    save_node = workflow["41"]["inputs"]
    save_node["custom_path"] = ""          # 走默认 output 目录
    save_node["custom_filename"] = out_stem
    save_node["format"] = "png"

    # 4) 提交给 Comfy
    log(f"Submitting job to Comfy for {input_name} ...")
    prompt_id = submit_to_comfy(workflow)
    log(f"Comfy prompt_id = {prompt_id}")

    # 5) 等待输出文件在 output 目录里出现
    COMFY_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_file = COMFY_OUTPUT_DIR / f"{out_stem}.png"
    wait_for_file(output_file, timeout=600)
    log(f"Comfy output ready at {output_file}")

    return output_file


def upload_output(job, local_output: Path) -> str:
    """把结果图上传到 Storage，返回 output_path 字符串。

    output_path 会复用 input_path 的目录结构（real-estate / replace-sky / remove-clutter / custom + 项目子目录），
    只是在同一目录下命名为 {job_id}-output.ext，方便在 Storage 后台按文件夹查看进度。
    """
    ext = local_output.suffix or ".png"

    # 从 input_path 中抽取 user/{user_id} 后面的目录前缀
    input_path = job["input_path"]
    input_parts = input_path.split("/")
    # 期望格式：user/{user_id}/.../filename
    # 我们复用 "..." 这部分作为输出目录
    if len(input_parts) >= 4 and input_parts[0] == "user" and input_parts[1] == job["user_id"]:
        # userId 之后到倒数第一个元素（文件名）之间的所有部分
        folder_prefix = "/".join(input_parts[2:-1])
        output_key = f"user/{job['user_id']}/{folder_prefix}/{job['id']}-output{ext}"
    else:
        # 兜底逻辑：保持老的扁平结构
        output_key = f"user/{job['user_id']}/{job['id']}-output{ext}"

    log(f"Uploading result to {output_key} ...")
    with local_output.open("rb") as f:
        supabase.storage.from_(IMAGES_BUCKET).upload(output_key, f)
    return output_key


def mark_done(job_id: str, output_path: str):
    supabase.table("jobs").update(
        {"status": "done", "output_path": output_path}
    ).eq("id", job_id).execute()


def mark_failed(job_id: str, message: str):
    """将任务标记为 failed，并记录错误信息。"""
    try:
        supabase.table("jobs").update(
            {"status": "failed", "error_message": message[:500]}
        ).eq("id", job_id).execute()
    except Exception as e:
        log(f"标记任务失败失败: {e}")


def main_loop():
    log("Worker started, waiting for jobs ...")
    while True:
        job = None
        try:
            job = fetch_next_job()
            if not job:
                time.sleep(5)
                continue

            log(f"Got job {job['id']} for user {job['user_id']}")
            local_in = download_input(job)
            local_out = process_image(local_in)
            output_key = upload_output(job, local_out)
            mark_done(job["id"], output_key)
            log(f"Job {job['id']} done -> {output_key}")
        except Exception as e:
            log(f"Error in main loop: {e}")
            if job is not None:
                try:
                    mark_failed(job["id"], str(e))
                except Exception:
                    # 标记失败本身出错时不要让 worker 崩溃
                    pass
            time.sleep(5)


if __name__ == "__main__":
    main_loop()
