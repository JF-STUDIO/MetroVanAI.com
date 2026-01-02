# handler.py
import os
import json
import subprocess
import tempfile
import boto3
import requests
import runpod

R2_ENDPOINT = os.getenv("R2_ENDPOINT")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY")
R2_RAW_BUCKET = os.getenv("R2_RAW_BUCKET", "mvai-raw")
R2_OUT_BUCKET = os.getenv("R2_OUT_BUCKET", "mvai-hdr-temp")

s3 = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT,
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
)


def download_files(files, input_dir):
    for f in files:
        key = f.get("r2_key_raw")
        if not key:
            continue
        dst = os.path.join(input_dir, os.path.basename(key))
        s3.download_file(R2_RAW_BUCKET, key, dst)


def upload_folder(folder, prefix):
    uploaded = []
    for root, _, files in os.walk(folder):
        for name in files:
            local = os.path.join(root, name)
            rel = os.path.relpath(local, folder)
            key = f"{prefix}/{rel}"
            s3.upload_file(local, R2_OUT_BUCKET, key)
            uploaded.append({"key": key, "name": name})
    return uploaded


def handler(job):
    data = job.get("input") or {}
    job_id = data.get("jobId")
    files = data.get("files") or []
    callback_url = data.get("callbackUrl")
    callback_secret = data.get("callbackSecret")

    print("📦 Job input:", json.dumps(data))

    with tempfile.TemporaryDirectory() as workdir:
        input_dir = os.path.join(workdir, "input")
        output_dir = os.path.join(workdir, "output")
        os.makedirs(input_dir, exist_ok=True)
        os.makedirs(output_dir, exist_ok=True)

        # 下载 R2 原图
        download_files(files, input_dir)

        # 跑分组+HDR（保持原脚本逻辑）
        try:
            subprocess.check_call([
                "/app/one_click_group_align_hdr.sh",
                input_dir,
                output_dir,
            ])
        except subprocess.CalledProcessError as e:
            # 失败也回调
            if callback_url:
                headers = {
                    "x-runpod-secret": callback_secret or "",
                    "Content-Type": "application/json",
                }
                requests.post(callback_url, headers=headers, data=json.dumps({
                    "jobId": job_id,
                    "error": f"hdr failed: {e}"
                }))
            return {"ok": False, "error": str(e)}

        # 上传结果
        uploads = upload_folder(output_dir, f"jobs/{job_id}")

        # 简单映射：每个输出文件都返回，供后端匹配
        result_groups = []
        for idx, item in enumerate(uploads):
            result_groups.append({
                "index": idx + 1,
                "resultKey": item["key"],
                "previewKey": item["key"],
                "representativeId": None,
            })

        # 回调
        if callback_url:
            headers = {
                "x-runpod-secret": callback_secret or "",
                "Content-Type": "application/json",
            }
            requests.post(callback_url, headers=headers, data=json.dumps({
                "jobId": job_id,
                "groups": result_groups,
                "uploads": uploads,
            }))

    return {
        "ok": True,
        "message": "worker executed successfully",
        "uploads": uploads,
    }


runpod.serverless.start({
    "handler": handler
})
