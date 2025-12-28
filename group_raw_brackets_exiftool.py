import os, sys, json, shutil
from datetime import datetime
import pandas as pd
import subprocess

RAW_EXT = {".arw", ".cr3", ".cr2", ".nef", ".rw2", ".orf", ".dng", ".raf"}

def list_raws(folder):
    files = []
    for fn in os.listdir(folder):
        ext = os.path.splitext(fn)[1].lower()
        if ext in RAW_EXT:
            files.append(os.path.join(folder, fn))
    return sorted(files)

def run_exiftool_json(files):
    # 读关键字段：时间、曝光补偿、快门、ISO、光圈、焦距、镜头、机身等
    cmd = [
        "exiftool", "-json",
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
        "-LensID",
        "-LensModel",
        "-Model",
        "-SerialNumber",
        "-SequenceNumber",
        "-BurstUUID",
        "-BracketSequence",
        "-BracketShotNumber",
        "-FileName",
        "-Directory",
    ] + files
    out = subprocess.check_output(cmd)
    return json.loads(out)

def parse_time(rec):
    # 优先 SubSecDateTimeOriginal (更精确)
    for k in ("SubSecDateTimeOriginal", "DateTimeOriginal", "CreateDate"):
        v = rec.get(k)
        if not v:
            continue
        s = str(v)
        # exiftool 的 SubSecDateTimeOriginal 可能类似 "2025:12:17 16:07:22.12"
        for fmt in ("%Y:%m:%d %H:%M:%S.%f", "%Y:%m:%d %H:%M:%S"):
            try:
                return datetime.strptime(s, fmt)
            except Exception:
                pass
    return None

def parse_float(v):
    if v is None:
        return None
    try:
        # exiftool 有时返回 "1/3" 或 "+0.7"
        s = str(v).strip()
        if "/" in s:
            num, den = s.split("/", 1)
            return float(num) / float(den)
        return float(s.replace("+",""))
    except Exception:
        return None

def parse_exposure_time(v):
    if v is None:
        return None
    s = str(v).strip()
    try:
        # 可能是 "1/125" 或 "0.008"
        if "/" in s:
            num, den = s.split("/", 1)
            return float(num) / float(den)
        return float(s)
    except Exception:
        return None

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
            dst = os.path.join(dst_folder, f"{name}_{i}{ext}")
            if not os.path.exists(dst):
                break
            i += 1
    shutil.copy2(src, dst)

def main(inp, out):
    raws = list_raws(inp)
    if not raws:
        print("No RAW files found.")
        return

    meta = run_exiftool_json(raws)

    rows = []
    for r in meta:
        dt = parse_time(r)
        if not dt:
            # 没时间就跳过（极少）
            continue
        ev = parse_float(r.get("ExposureBiasValue") or r.get("ExposureCompensation"))
        shutter = parse_exposure_time(r.get("ExposureTime") or r.get("ShutterSpeed"))
        iso = parse_float(r.get("ISO"))
        fnum = parse_float(r.get("FNumber") or r.get("Aperture"))
        focal = parse_float(r.get("FocalLength"))
        seq = r.get("SequenceNumber")
        burst = r.get("BurstUUID")
        bseq = r.get("BracketSequence")
        bshot = r.get("BracketShotNumber")

        fullpath = os.path.join(r.get("Directory",""), r.get("FileName",""))
        rows.append({
            "path": fullpath,
            "time": dt,
            "ev": ev,
            "shutter": shutter,
            "iso": iso,
            "fnum": fnum,
            "focal": focal,
            "seq": seq,
            "burst": burst,
            "bracket_seq": bseq,
            "bracket_shot": bshot,
        })

    df = pd.DataFrame(rows).sort_values("time").reset_index(drop=True)

    # 分组策略（exiftool-only）：
    # - 同一组通常在 1~3 秒内完成
    # - 曝光补偿/快门会变化，但光圈/焦距通常不变
    TIME_GAP_SEC = 3.0

    groups = []
    cur = []

    def same_setup(a, b):
        # 光圈/焦距相近认为同一构图（容错）
        if a["fnum"] and b["fnum"] and abs(a["fnum"] - b["fnum"]) > 0.2:
            return False
        if a["focal"] and b["focal"] and abs(a["focal"] - b["focal"]) > 2.0:
            return False
        return True

    for _, row in df.iterrows():
        if not cur:
            cur = [row]
            continue
        prev = cur[-1]
        dt = (row["time"] - prev["time"]).total_seconds()

        ev_diff = abs(safe_num(row["ev"]) - safe_num(prev["ev"]))
        shutter_diff = shutter_ratio(row["shutter"], prev["shutter"])

        room_switch = (
            dt > 1.2 and
            ev_diff >= 0.7 and
            shutter_diff >= 2.0
        )

        if dt <= TIME_GAP_SEC and same_setup(prev, row) and not room_switch:
            cur.append(row)
        else:
            groups.append(cur)
            cur = [row]
    if cur:
        groups.append(cur)

    # 输出
    ensure_dir(out)
    for i, g in enumerate(groups, 1):
        gdf = pd.DataFrame(g)

        # 组内排序：有 EV 用 EV；没 EV 用快门（曝光时间越长通常越亮）
        if gdf["ev"].notna().any():
            gdf = gdf.sort_values("ev")
        elif gdf["shutter"].notna().any():
            gdf = gdf.sort_values("shutter")
        else:
            gdf = gdf.sort_values("time")

        ts = gdf.iloc[0]["time"].strftime("%Y%m%d_%H%M%S")
        folder = os.path.join(out, f"group_{i:04d}_{ts}_{len(gdf)}raws")
        ensure_dir(folder)

        gdf.to_csv(os.path.join(folder, "_manifest.csv"), index=False)

        # Confidence scoring
        reasons = []
        score = 0.0
        is_hdr_candidate = False
        try:
            ev_span = ev_range(gdf)
            if ev_span >= 0.6:
                score += 0.35
                reasons.append("ev_range_ok")
                is_hdr_candidate = True

            shot_count = len(gdf)
            if shot_count in (3, 5):
                score += 0.25
                reasons.append(f"shot_count_{shot_count}")
            if shot_count < 2 or shot_count > 7:
                score -= 0.20
                reasons.append("shot_count_out_of_range")

            time_gaps = gdf["time"].diff().dt.total_seconds()
            max_gap = time_gaps.max() if len(time_gaps) else None
            if max_gap is not None and not pd.isna(max_gap) and max_gap <= 1.5:
                score += 0.20
                reasons.append("time_gap_ok")

            fnum_std = gdf["fnum"].std()
            if fnum_std is not None and not pd.isna(fnum_std) and fnum_std < 0.1:
                score += 0.10
                reasons.append("same_aperture")

            focal_std = gdf["focal"].std()
            if focal_std is not None and not pd.isna(focal_std) and focal_std < 1.0:
                score += 0.10
                reasons.append("same_focal_length")

            if score < 0:
                score = 0.0
            score = min(score, 1.0)
        except Exception:
            score = 0.0
            reasons = ["confidence_error"]

        confidence = {
            "confidence_score": round(score, 3),
            "auto_approved": score >= 0.85,
            "needs_review": 0.65 <= score < 0.85,
            "auto_hold": score < 0.65,
            "is_hdr_candidate": is_hdr_candidate,
            "reason": reasons
        }
        try:
            with open(os.path.join(folder, "_confidence.json"), "w") as f:
                json.dump(confidence, f, indent=2)
        except Exception:
            pass

        for p in gdf["path"].tolist():
            if os.path.exists(p):
                safe_copy(p, folder)

    print(f"Done. Groups: {len(groups)}. Output: {out}")
    print("Tip: If grouping is too strict/loose, change TIME_GAP_SEC (e.g., 2.0 or 5.0).")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python3 group_raw_brackets_exiftool.py <input_folder> <output_folder>")
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
