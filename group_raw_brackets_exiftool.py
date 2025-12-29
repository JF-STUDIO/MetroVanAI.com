import os, sys, json, shutil, math
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
    BASE_GAP_SEC = 1.2
    EXP_GAP_FACTOR = 2.5

    def allowed_gap_sec(a, b):
        exp_a = safe_num(a.get("shutter"), 0.0)
        exp_b = safe_num(b.get("shutter"), 0.0)
        max_exp = max(exp_a, exp_b)
        dynamic = BASE_GAP_SEC + (EXP_GAP_FACTOR * max_exp)
        return max(TIME_GAP_SEC, dynamic)

    def same_setup(a, b):
        # 光圈/焦距相近认为同一构图（容错）
        if a["fnum"] and b["fnum"] and abs(a["fnum"] - b["fnum"]) > 0.2:
            return False
        if a["focal"] and b["focal"] and abs(a["focal"] - b["focal"]) > 2.0:
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
            cur = [row]
            continue
        prev = cur[-1]
        dt = (row["time"] - prev["time"]).total_seconds()
        if dt <= allowed_gap_sec(prev, row) and same_setup(prev, row):
            cur.append(row)
        else:
            time_groups.append(cur)
            cur = [row]
    if cur:
        time_groups.append(cur)

    groups = []
    for cluster in time_groups:
        groups.extend(split_exposure_cluster(cluster))

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

            ordered = gdf.sort_values("time").reset_index(drop=True)
            if len(ordered) > 1:
                gap_ok = True
                for idx in range(1, len(ordered)):
                    prev = ordered.iloc[idx - 1]
                    curr = ordered.iloc[idx]
                    actual_gap = (curr["time"] - prev["time"]).total_seconds()
                    allowed_gap = allowed_gap_sec(prev, curr)
                    if actual_gap > allowed_gap:
                        gap_ok = False
                        break
                if gap_ok:
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
