#!/usr/bin/env bash
set -e

IN_DIR="$1"
OUT_DIR="$2"

if [ -z "$IN_DIR" ] || [ -z "$OUT_DIR" ]; then
  echo "Usage: bash $0 <INPUT_FOLDER> <OUTPUT_FOLDER>"
  exit 1
fi

# === 可执行依赖（走 PATH，不写死） ===
PYTHON_BIN="${PYTHON_BIN:-python3}"
ALIGN_BIN="$(command -v align_image_stack || true)"
# 直接使用绝对路径，避免 ../ 计算错误
GROUP_SCRIPT="/app/group_raw_brackets_exiftool.py"

GROUPED_DIR="$OUT_DIR/RAW_GROUPED"
FINAL_DIR="$OUT_DIR/HDR_FINAL"
mkdir -p "$GROUPED_DIR" "$FINAL_DIR"

# === 依赖检查 ===
command -v "$PYTHON_BIN" >/dev/null || { echo "❌ Missing python3"; exit 1; }
command -v exiftool >/dev/null || { echo "❌ Missing exiftool"; exit 1; }
command -v magick >/dev/null || { echo "❌ Missing ImageMagick (magick)"; exit 1; }
[ -n "$ALIGN_BIN" ] || { echo "❌ Missing align_image_stack"; exit 1; }
[ -f "$GROUP_SCRIPT" ] || { echo "❌ Missing group script: $GROUP_SCRIPT"; exit 1; }

echo "IN_DIR : $IN_DIR"
echo "OUT_DIR: $OUT_DIR"
echo "GROUP_SCRIPT: $GROUP_SCRIPT"
echo "ALIGN_BIN: $ALIGN_BIN"

# === 1) RAW 分组 ===
"$PYTHON_BIN" "$GROUP_SCRIPT" "$IN_DIR" "$GROUPED_DIR" --mode A

echo "Processing groups -> HDR / single"

# === 2) 逐组处理 ===
for g in "$GROUPED_DIR"/group_*; do
  [ -d "$g" ] || continue
  gname="$(basename "$g")"

  jpg_dir="$g/jpg"
  fix_dir="$g/fixed"
  align_dir="$g/aligned"
  mkdir -p "$jpg_dir" "$fix_dir" "$align_dir"
  rm -f "$jpg_dir"/*.jpg "$fix_dir"/*.jpg "$align_dir"/*.tif 2>/dev/null || true

  files=$(find "$g" -maxdepth 1 -type f \( \
    -iname "*.arw" -o -iname "*.cr2" -o -iname "*.cr3" -o -iname "*.nef" -o -iname "*.dng" \
    -o -iname "*.rw2" -o -iname "*.orf" -o -iname "*.raf" \
    -o -iname "*.jpg" -o -iname "*.jpeg" \
  \))

  count=$(echo "$files" | grep -c . || true)
  [ "$count" -gt 0 ] || continue

  # === 单张 ===
  if [ "$count" -eq 1 ]; then
    f="$files"
    echo "==> $gname (single)"
    if echo "$f" | grep -Eiq '\.(jpg|jpeg)$'; then
      cp -f "$f" "$FINAL_DIR/${gname}.jpg"
    else
      exiftool -PreviewImage -b "$f" > "$FINAL_DIR/${gname}.jpg" 2>/dev/null || \
      exiftool -JpgFromRaw -b "$f" > "$FINAL_DIR/${gname}.jpg"
    fi
    continue
  fi

  echo "==> $gname (HDR, images=$count)"

  # === 导出 JPG ===
  for f in $files; do
    name="$(basename "${f%.*}")"
    if echo "$f" | grep -Eiq '\.(jpg|jpeg)$'; then
      cp -f "$f" "$jpg_dir/$name.jpg"
    else
      exiftool -PreviewImage -b "$f" > "$jpg_dir/$name.jpg" 2>/dev/null || \
      exiftool -JpgFromRaw -b "$f" > "$jpg_dir/$name.jpg"
    fi
  done

  set -- "$jpg_dir"/*.jpg
  [ -f "$1" ] || { echo "  !! JPG extract failed"; continue; }

  # === 统一画布 ===
  maxw=0; maxh=0
  for j in "$jpg_dir"/*.jpg; do
    read w h <<< "$(magick identify -format '%w %h' "$j" 2>/dev/null || echo '0 0')"
    (( w > maxw )) && maxw="$w"
    (( h > maxh )) && maxh="$h"
  done

  idx=0
  for j in "$jpg_dir"/*.jpg; do
    ((idx++))
    magick "$j" -auto-orient -background black -gravity center \
      -extent "${maxw}x${maxh}" \
      "$fix_dir/$(printf "%03d.jpg" "$idx")"
  done

  # === 对齐 ===
  ( cd "$align_dir" && "$ALIGN_BIN" -m -a aligned_ "$fix_dir"/*.jpg )

  set -- "$align_dir"/aligned_*.tif
  [ -f "$1" ] || { echo "  !! Align failed"; continue; }

  # === 融合 ===
  magick "$align_dir"/aligned_*.tif \
    -evaluate-sequence mean \
    -contrast-stretch 0.5%x0.5% \
    "$FINAL_DIR/${gname}.jpg"

done

echo "✅ Done."
echo "Final outputs in: $FINAL_DIR"
