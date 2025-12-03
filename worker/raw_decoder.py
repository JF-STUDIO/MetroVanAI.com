from __future__ import annotations

from pathlib import Path
from typing import Iterable

import imageio.v2 as imageio

try:
    import rawpy  # type: ignore[import]
except ImportError:  # 在某些环境（比如没装 rawpy 的本地开发机）可能不存在
    rawpy = None


# 常见相机 RAW 后缀（索尼/佳能/尼康等）
CAMERA_RAW_EXTS = {".cr2", ".cr3", ".arw", ".nef", ".nrw", ".dng", ".raf", ".orf", ".rw2", ".srw"}


def is_camera_raw_suffix(suffix: str) -> bool:
    """判断文件后缀是否为常见相机 RAW 格式（统一用小写后缀）。"""
    return suffix.lower() in CAMERA_RAW_EXTS


def decode_camera_raw_to_jpg(raw_path: Path, output_dir: Path) -> Path:
    """使用 rawpy 将相机 RAW 解码为 JPG，并返回输出路径。

    如果环境中没有安装 rawpy，会抛出 RuntimeError，交给上层决定如何处理。
    """

    if rawpy is None:
        raise RuntimeError("rawpy 未安装，无法解码相机 RAW 文件")

    output_dir.mkdir(parents=True, exist_ok=True)
    jpg_path = output_dir / f"{raw_path.stem}.jpg"

    # rawpy 期望传入字符串路径，这里显式转成 str，避免 'PosixPath' encode 问题
    with rawpy.imread(str(raw_path)) as raw:  # type: ignore[call-arg]
        rgb = raw.postprocess()

    imageio.imwrite(jpg_path, rgb, quality=95)
    return jpg_path
