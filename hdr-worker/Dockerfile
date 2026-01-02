FROM python:3.10-slim

WORKDIR /app

# 系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    exiftool \
    hugin-tools \
    imagemagick \
    && rm -rf /var/lib/apt/lists/*

# Python 依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 脚本
COPY handler.py .
COPY group_raw_brackets_exiftool.py .
COPY scripts/one_click_group_align_hdr.sh /app/one_click_group_align_hdr.sh
RUN chmod +x /app/one_click_group_align_hdr.sh

CMD ["python", "-u", "handler.py"]