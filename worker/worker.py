import os
import time
import json
import shutil
from pathlib import Path
import sys

from dotenv import load_dotenv
from PIL import Image
import imageio.v2 as imageio
import requests
from supabase import create_client, Client

# Add the directory containing raw_decoder.py to sys.path
# This ensures that 'raw_decoder' can be found when worker.py is run directly as a script.
worker_dir = Path(__file__).resolve().parent
if str(worker_dir) not in sys.path:
    sys.path.insert(0, str(worker_dir))


# Support both package and script execution
try:
    from .raw_decoder import is_camera_raw_suffix, decode_camera_raw_to_jpg
except ImportError:
    from raw_decoder import is_camera_raw_suffix, decode_camera_raw_to_jpg

# 从项目根目录和 worker 同目录加载 .env（如果存在）
project_root_env = Path(__file__).resolve().parents[1] / ".env"
worker_env = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=project_root_env)
load_dotenv(dotenv_path=worker_env)

# ===== 配置区 =====
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError(
        "必须设置 SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY 环境变量，或者在项目根目录/worker 目录放置 .env 文件。"\
        "\n示例 .env 内容：\n"
        "SUPABASE_URL=https://你的-project-id.supabase.co\n"
        "SUPABASE_SERVICE_ROLE_KEY=你的-service-role-key\n"
        "\n在 runpod 容器里，你可以：\n"
        "1）在 /workspace/runpod-slim/realestate-ai/.env 写入以上内容，或者\n"
        "2）在启动/进入容器后执行：export SUPABASE_URL=... && export SUPABASE_SERVICE_ROLE_KEY=...\n"
    )

IMAGES_BUCKET = "images"
DOWNLOAD_DIR = Path("/tmp/jobs")
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
COMFY_INPUT_DIR = Path(os.environ.get("COMFY_INPUT_DIR", "/workspace/runpod-slim/ComfyUI/input"))
COMFY_OUTPUT_DIR = Path(os.environ.get("COMFY_OUTPUT_DIR", "/workspace/runpod-slim/ComfyUI/output"))

# ComfyUI workflow 配置：可以通过环境变量 COMFY_WORKFLOW_PATH 覆盖默认路径
# 默认使用你导出的 FANGDICHANTIAOSE.json 工作流文件
DEFAULT_WORKFLOW_PATH = Path(__file__).parent / "FANGDICHANTIAOSE.json"
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
    """打印日志，强制使用 UTF-8，避免 ascii 编码错误。"""
    import sys
    try:
        # 尽量按终端编码打印
        print(msg, flush=True)
    except UnicodeEncodeError:
        # 退而求其次，直接写入字节流，避免 worker 挂掉
        sys.stdout.buffer.write((str(msg) + "\n").encode("utf-8", errors="replace"))
        sys.stdout.flush()


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

    规则：
    - 目录结构完全复用 input_path（包括 real-estate / replace-sky / remove-clutter / custom + 项目子目录）。
    - 文件名在原始文件名（去掉扩展名）的基础上加后缀 `_edited`，扩展名使用实际输出文件的扩展名。
    例如：
    input_path = user/{user_id}/real-estate/3756_ace/1764-DSC0153.ARW
    -> output_path = user/{user_id}/real-estate/3756_ace/1764-DSC0153_edited.png
    """
    ext = local_output.suffix or ".png"

    input_path = job["input_path"]
    input_parts = input_path.split("/")

    # 期望格式：user/{user_id}/.../filename
    if len(input_parts) >= 4 and input_parts[0] == "user" and input_parts[1] == job["user_id"]:
        # 目录前缀：user/{user_id}/.../（不含原始文件名）
        folder_prefix = "/".join(input_parts[:-1])
        # 原始文件名（不含扩展名），例如 1764-DSC0153
        original_filename = input_parts[-1]
        original_stem = original_filename.rsplit(".", 1)[0]
        edited_filename = f"{original_stem}_edited{ext}"
        output_key = f"{folder_prefix}/{edited_filename}"
    else:
        # 兜底逻辑：如果 input_path 不符合预期，就放在 user/{user_id}/ 目录下，仍然保留原始文件名 + _edited
        original_filename = Path(input_path).name
        original_stem = original_filename.rsplit(".", 1)[0]
        edited_filename = f"{original_stem}_edited{ext}"
        output_key = f"user/{job['user_id']}/{edited_filename}"

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

            # 扣减用户余额（每完成一张任务减 1，余额最低为 0）
            try:
                # 让数据库函数 decrement_balance 自己更新余额（推荐做法），这里只调用，不再把 RPC 结果塞进 profiles.update
                supabase.rpc("decrement_balance", {"user_id": job["user_id"]}).execute()
            except Exception as e:
                log(f"扣减余额失败（忽略，不阻塞任务完成）: {e}")

            mark_done(job["id"], output_key)
            log(f"Job {job['id']} done -> {output_key}")
        except Exception as e:
            import traceback
            traceback.print_exc()
            log(f"Error in main loop: {repr(e)}")
            if job is not None:
                try:
                    mark_failed(job["id"], str(e))
                except Exception:
                    # 标记失败本身出错时不要让 worker 崩溃
                    pass
            time.sleep(5)


if __name__ == "__main__":
    main_loop()
