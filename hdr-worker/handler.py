
import os
import json
import subprocess
import tempfile
import boto3
import requests
import runpod

# Environment Variables
R2_ENDPOINT = os.getenv("R2_ENDPOINT")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY")
R2_RAW_BUCKET = os.getenv("R2_RAW_BUCKET", "mvai-raw")
R2_OUT_BUCKET = os.getenv("R2_OUT_BUCKET", "mvai-hdr")

# Boto3 Client
s3 = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT,
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
)

def download_files(files, input_dir):
    """
    Download files from R2 to input_dir.
    'files' is a list of dicts: { "r2_key": "...", "r2_bucket": "..." }
    """
    print(f"📥 Downloading {len(files)} files...")
    for f in files:
        key = f.get("r2_key") or f.get("r2_key_raw")
        bucket = f.get("r2_bucket") or R2_RAW_BUCKET
        
        if not key:
            print("⚠️ Skipping file with no key:", f)
            continue
            
        print(f"   Downloading s3://{bucket}/{key}")
        # Preserve filename from key
        filename = os.path.basename(key)
        dst = os.path.join(input_dir, filename)
        
        try:
            s3.download_file(bucket, key, dst)
        except Exception as e:
            print(f"❌ Failed to download {key}: {e}")
            raise e

def upload_file(local_path, r2_key):
    """
    Upload a single file to R2.
    """
    print(f"📤 Uploading {local_path} to s3://{R2_OUT_BUCKET}/{r2_key}")
    try:
        s3.upload_file(local_path, R2_OUT_BUCKET, r2_key)
        return r2_key
    except Exception as e:
        print(f"❌ Failed to upload {r2_key}: {e}")
        raise e

def handler(job):
    """
    Main RunPod Handler
    Expected Input:
    {
        "input": {
            "jobId": "...",
            "groupId": "...",
            "files": [ { "r2_key": "..." }, ... ],
            "callbackUrl": "..."
        }
    }
    """
    job_input = job.get("input") or {}
    
    job_id = job_input.get("jobId")
    group_id = job_input.get("groupId")
    files = job_input.get("files") or []
    callback_url = job_input.get("callbackUrl")
    # Secret optional for security
    callback_secret = job_input.get("callbackSecret") 

    if not job_id or not group_id:
        return {"error": "Missing jobId or groupId"}

    print(f"🚀 Starting Handler for Job {job_id}, Group {group_id}")

    with tempfile.TemporaryDirectory() as workdir:
        input_dir = os.path.join(workdir, "input")
        output_dir = os.path.join(workdir, "output")
        os.makedirs(input_dir, exist_ok=True)
        os.makedirs(output_dir, exist_ok=True)

        # 1. Download
        try:
            download_files(files, input_dir)
        except Exception as e:
            return _send_error(callback_url, job_id, group_id, str(e))

        # 2. Process (HDR)
        # We assume the shell script aligns and merges ALL files in input_dir 
        # into a single output or multiple outputs in output_dir.
        # For a single group, we expect ONE main HDR output usually.
        script_path = "/app/one_click_group_align_hdr.sh"
        if not os.path.exists(script_path):
             return _send_error(callback_url, job_id, group_id, "Worker script not found")

        print("⚙️ Executing HDR script...")
        try:
            subprocess.check_call([script_path, input_dir, output_dir])
        except subprocess.CalledProcessError as e:
            print(f"❌ Processing failed: {e}")
            return _send_error(callback_url, job_id, group_id, f"HDR script failed: {e}")

        # 3. Upload Results
        # Find the JPG result. 
        # We expect the script to produce something like `result.jpg` or `input_name_hdr.jpg`.
        # We will upload ALL jpgs found in output_dir.
        
        uploaded_results = []
        for root, _, out_files in os.walk(output_dir):
            for name in out_files:
                if name.lower().endswith('.jpg') or name.lower().endswith('.jpeg') or name.lower().endswith('.tif'):
                    local_path = os.path.join(root, name)
                    # Construct R2 Key: jobs/{jobId}/hdr/{groupId}/{name}
                    target_key = f"jobs/{job_id}/hdr/{group_id}/{name}"
                    upload_file(local_path, target_key)
                    uploaded_results.append(target_key)

        if not uploaded_results:
             return _send_error(callback_url, job_id, group_id, "No HDR output produced")

        # 4. Success Callback
        # We pick the first one as 'resultKey' if multiple (usually 1)
        result_key = uploaded_results[0]
        
        payload = {
            "jobId": job_id,
            "groups": [{
                "groupId": group_id, # Echo back
                "resultKey": result_key,
                "allUploads": uploaded_results
            }],
            "status": "success"
        }
        
        print("✅ Finished. Sending callback...", payload)
        if callback_url:
            try:
                requests.post(callback_url, json=payload, timeout=10)
            except Exception as e:
                print(f"⚠️ Callback failed: {e}")

        return payload

def _send_error(url, job_id, group_id, error_msg):
    print(f"❌ Reporting error: {error_msg}")
    if url:
        try:
            requests.post(url, json={
                "jobId": job_id,
                "groups": [{
                    "groupId": group_id,
                    "error": error_msg
                }],
                "error": error_msg
            }, timeout=10)
        except:
            pass
    return {"error": error_msg}

if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
