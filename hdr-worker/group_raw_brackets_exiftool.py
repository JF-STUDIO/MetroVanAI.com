#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os, sys, json, shutil, re, argparse, subprocess, csv, math
from datetime import datetime
import pandas as pd

RAW_EXTS = {
    ".arw", ".cr2", ".cr3", ".nef", ".dng", ".rw2", ".orf", ".raf",
    ".jpg", ".jpeg"
}

EXIF_FIELDS = [
    "-DateTimeOriginal",
    "-CreateDate",
    "-SubSecDateTimeOriginal",
    "-ExposureBiasValue",
    "-ExposureCompensation",
    "-ExposureTime",
    "-ShutterSpeed",
    "-ISO",
    "-FNumber",
    "-Aperture",
    "-FocalLength",
    "-LensModel",
    "-Model",
    "-SerialNumber",
    "-ImageWidth",
    "-ImageHeight",
    "-Orientation",
    "-SequenceNumber",
    "-BurstUUID",
    "-BracketSequence",
    "-BracketShotNumber",
    "-FileName",
    "-Directory",
]

def list_files(folder):
    return sorted(
        os.path.join(folder, f)
        for f in os.listdir(folder)
        if os.path.splitext(f)[1].lower() in RAW_EXTS
    )

def run_exiftool_json(files):
    cmd = ["exiftool", "-json"] + EXIF_FIELDS + files
    out = subprocess.check_output(cmd)
    return json.loads(out)

def parse_time(rec):
    for k in ("SubSecDateTimeOriginal", "DateTimeOriginal", "CreateDate"):
        v = rec.get(k)
        if not v:
            continue
        s = str(v).strip()
        for fmt in ("%Y:%m:%d %H:%M:%S.%f", "%Y:%m:%d %H:%M:%S"):
            try:
                return datetime.strptime(s, fmt)
            except Exception:
                pass
    return None

_num_re = re.compile(r"[-+]?\d+(?:\.\d+)?")

def parse_num(v):
    if v is None:
        return None
    s = str(v).strip()
    if "/" in s:
        try:
            a, b = s.split("/", 1)
            return float(a) / float(b)
        except Exception:
            return None
    m = _num_re.search(s.replace("+", ""))
    return float(m.group(0)) if m else None

def ensure_dir(p):
    os.makedirs(p, exist_ok=True)

def safe_copy(src, dst_folder):
    ensure_dir(dst_folder)
    base = os.path.basename(src)
    dst = os.path.join(dst_folder, base)
    if os.path.exists(dst):
        name, ext = os.path.splitext(base)
        i = 1
        while True:
            cand = os.path.join(dst_folder, f"{name}_{i}{ext}")
            if not os.path.exists(cand):
                dst = cand
                break
            i += 1
    shutil.copy2(src, dst)

def aspect_ratio(w, h):
    try:
        return float(w) / float(h)
    except Exception:
        return None

def close_enough(a, b, tol):
    return a is None or b is None or abs(a - b) <= tol

def ratio_close(a, b, tol):
    return a is None or b is None or min(a, b) == 0 or max(a, b) / min(a, b) <= tol

def make_row(r):
    dt = parse_time(r)
    if not dt:
        return None
    return {
        "path": os.path.join(r.get("Directory",""), r.get("FileName","")),
        "time": dt,
        "ev": parse_num(r.get("ExposureBiasValue") or r.get("ExposureCompensation")),
        "shutter": parse_num(r.get("ExposureTime") or r.get("ShutterSpeed")),
        "iso": parse_num(r.get("ISO")),
        "fnum": parse_num(r.get("FNumber") or r.get("Aperture")),
        "focal": parse_num(r.get("FocalLength")),
        "width": parse_num(r.get("ImageWidth")),
        "height": parse_num(r.get("ImageHeight")),
        "orientation": str(r.get("Orientation")),
        "model": str(r.get("Model")),
        "serial": str(r.get("SerialNumber")),
        "seq": parse_num(r.get("SequenceNumber")),
        "burst": str(r.get("BurstUUID")),
        "bracket_seq": str(r.get("BracketSequence")),
        "bracket_shot": str(r.get("BracketShotNumber")),
    }

def ev_range(gdf):
    evs = gdf["ev"].dropna()
    if len(evs) < 2:
        return 0.0
    try:
        return float(evs.max() - evs.min())
    except Exception:
        return 0.0

def shutter_ratio(a, b):
    if a is None or b is None:
        return 1.0
    try:
        if pd.isna(a) or pd.isna(b):
            return 1.0
        a = float(a)
        b = float(b)
        if a == 0 or b == 0:
            return 1.0
        return max(a, b) / min(a, b)
    except Exception:
        return 1.0

def safe_num(v, default=0.0):
    if v is None:
        return default
    try:
        if pd.isna(v):
            return default
    except Exception:
        pass
    try:
        return float(v)
    except Exception:
        return default

def group_rows(rows, args):
    df = pd.DataFrame(rows).sort_values("time").reset_index(drop=True)
    if df.empty:
        return []

    TIME_GAP_SEC = 3.0
    BASE_GAP_SEC = 1.2
    EXP_GAP_FACTOR = 2.5

    def allowed_gap_sec(a, b):
        exp_a = safe_num(a.get("shutter"), 0.0)
        exp_b = safe_num(b.get("shutter"), 0.0)
        max_exp = max(exp_a, exp_b)
        dynamic = BASE_GAP_SEC + (EXP_GAP_FACTOR * max_exp)
        return max(TIME_GAP_SEC, dynamic)

    def same_setup(a, b):
        if a.get("fnum") and b.get("fnum") and abs(a["fnum"] - b["fnum"]) > 0.2:
            return False
        if a.get("focal") and b.get("focal") and abs(a["focal"] - b["focal"]) > 2.0:
            return False
        return True

    def exposure_value(item):
        if item.get("ev") is not None:
            return safe_num(item.get("ev"), None)
        shutter = safe_num(item.get("shutter"), None)
        if shutter is not None and shutter > 0:
            return float(math.log2(shutter))
        return None

    def split_exposure_cluster(cluster):
        if len(cluster) <= 1:
            return [cluster]
        if len(cluster) <= 7:
            return [cluster]
        ordered = sorted(cluster, key=lambda x: x["time"])
        groups = []
        current = []
        direction = 0
        start_exp = None
        min_exp = None
        max_exp = None

        def push_current():
            nonlocal current, direction, start_exp, min_exp, max_exp
            if current:
                groups.append(current)
            current = []
            direction = 0
            start_exp = None
            min_exp = None
            max_exp = None

        def update_range(exp):
            nonlocal min_exp, max_exp
            if exp is None:
                return
            if min_exp is None or exp < min_exp:
                min_exp = exp
            if max_exp is None or exp > max_exp:
                max_exp = exp

        for item in ordered:
            if not current:
                current = [item]
                exp = exposure_value(item)
                start_exp = exp
                update_range(exp)
                continue

            prev = current[-1]
            dt = (item["time"] - prev["time"]).total_seconds()
            if dt > allowed_gap_sec(prev, item) or not same_setup(prev, item):
                push_current()
                current = [item]
                exp = exposure_value(item)
                start_exp = exp
                update_range(exp)
                continue

            if len(current) >= 7:
                push_current()
                current = [item]
                exp = exposure_value(item)
                start_exp = exp
                update_range(exp)
                continue

            exp = exposure_value(item)
            prev_exp = exposure_value(prev)
            if exp is not None and prev_exp is not None:
                delta = exp - prev_exp
                if direction == 0 and abs(delta) >= 0.4:
                    direction = 1 if delta > 0 else -1

                exp_range = 0.0
                if min_exp is not None and max_exp is not None:
                    exp_range = max_exp - min_exp

                sign_flip = direction != 0 and ((direction > 0 and delta < -0.6) or (direction < 0 and delta > 0.6))
                back_to_start = start_exp is not None and abs(exp - start_exp) <= 0.4

                if len(current) >= 2 and sign_flip and (back_to_start or exp_range >= 0.6):
                    push_current()
                    current = [item]
                    start_exp = exp
                    update_range(exp)
                    continue

            current.append(item)
            update_range(exp)

        if current:
            groups.append(current)
        return groups

    time_groups = []
    cur = []
    for _, row in df.iterrows():
        if not cur:
            cur = [row.to_dict()]
            continue
        prev = cur[-1]
        dt = (row["time"] - prev["time"]).total_seconds()
        if dt <= allowed_gap_sec(prev, row) and same_setup(prev, row):
            cur.append(row.to_dict())
        else:
            time_groups.append(cur)
            cur = [row.to_dict()]
    if cur:
        time_groups.append(cur)

    groups = []
    for cluster in time_groups:
        groups.extend(split_exposure_cluster(cluster))

    return groups

# === 主函数 ===
def main(inp, out, args):
    files = list_files(inp)
    meta = run_exiftool_json(files)

    rows = [make_row(r) for r in meta if make_row(r)]
    rows = sorted(rows, key=lambda x: x["time"])

    groups = group_rows(rows, args)

    ensure_dir(out)
    for i, g in enumerate(groups, 1):
        ts = g[0]["time"].strftime("%Y%m%d_%H%M%S")
        folder = os.path.join(out, f"group_{i:04d}_{ts}_{len(g)}files")
        ensure_dir(folder)
        for r in g:
            safe_copy(r["path"], folder)

    print(f"Done. Groups: {len(groups)}")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("input_folder")
    ap.add_argument("output_folder")
    ap.add_argument("--mode", choices=["A","B"], default="A")
    ap.add_argument("--gap", type=float, default=6.0)
    ap.add_argument("--span", type=float, default=12.0)
    ap.add_argument("--ar_ratio", type=float, default=1.25)
    ap.add_argument("--fnum_tol", type=float, default=0.6)
    ap.add_argument("--iso_ratio", type=float, default=2.2)
    ap.add_argument("--focal_tol", type=float, default=6.0)
    ap.add_argument("--score_thr", type=int, default=6)
    args = ap.parse_args()
    sys.exit(main(args.input_folder, args.output_folder, args))
