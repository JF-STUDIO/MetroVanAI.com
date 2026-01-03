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


def download_files(files, input_dir, skip_ids=None):
    skip_ids = set(skip_ids or [])
    for f in files:
        file_id = f.get("id")
        if file_id and file_id in skip_ids:
            continue
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
    skip_file_ids = set(data.get("skipFileIds") or [])

    print("📦 Job input:", json.dumps(data))

    with tempfile.TemporaryDirectory() as workdir:
        input_dir = os.path.join(workdir, "input")
        output_dir = os.path.join(workdir, "output")
        os.makedirs(input_dir, exist_ok=True)
        os.makedirs(output_dir, exist_ok=True)

        # 下载 R2 原图
        download_files(files, input_dir, skip_file_ids)

        # 如果没有任何文件，直接返回错误，避免脚本无输出退出
        downloaded = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
        if not downloaded:
            msg = "no input files downloaded from R2 (check r2_key_raw and R2_* envs)"
            print("❌", msg)
            if callback_url:
                headers = {
                    "x-runpod-secret": callback_secret or "",
                    "Content-Type": "application/json",
                }
                requests.post(callback_url, headers=headers, data=json.dumps({
                    "jobId": job_id,
                    "error": msg,
                }))
            return {"ok": False, "error": msg}

        # 跑分组+HDR（保持原脚本逻辑）
        cmd = ["/app/one_click_group_align_hdr.sh", input_dir, output_dir]
        result = subprocess.run(cmd, capture_output=True, text=True)
        print("HDR stdout:\n", result.stdout)
        print("HDR stderr:\n", result.stderr)

        if result.returncode != 0:
            err_msg = f"hdr failed rc={result.returncode}"
            # 失败也回调，附带 stderr 方便排查
            if callback_url:
                headers = {
                    "x-runpod-secret": callback_secret or "",
                    "Content-Type": "application/json",
                }
                requests.post(callback_url, headers=headers, data=json.dumps({
                    "jobId": job_id,
                    "error": err_msg,
                    "stderr": result.stderr,
                    "stdout": result.stdout,
                }))
            return {
                "ok": False,
                "error": err_msg,
                "stderr": result.stderr,
                "stdout": result.stdout,
            }

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
