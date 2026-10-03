#!/usr/bin/env python3
"""Data-loss / timing health check for a dashboard recording.

    python tools/analyze_recording.py                 # newest session in recordings/
    python tools/analyze_recording.py 20261001_110424 # a specific session

Pure Python (no numpy/scipy), so it runs with the app's own .venv.

Reports:
  * BLE packet loss — gaps in the ECG sequence numbers (packets that left the
    strap but never reached the host).
  * Firmware sample loss — ECG samples that were never put into a packet. R-R
    counted in ECG samples is compared with the firmware's own RR (timer based):
    effective rate = fs * RR_samples / RR_firmware. ~fs = no loss. The sample rate
    comes from meta_<session>.json (written by the app; 250 Hz if absent).
  * RR irregularity and ectopy (PAC/PVC/artifact) rates per hour — timing glitches
    in the firmware show up as spurious "premature" beats, mostly PAC.
"""
import csv
import glob
import json
import os
import statistics
import sys

FS = 250
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REC = os.path.join(HERE, "recordings")


def read_csv(path):
    with open(path, newline="") as f:
        r = csv.reader(f)
        next(r, None)
        return [row for row in r if row]


def detect_r(x):
    """R peaks at full resolution. Detection runs on a ~250 Hz block-averaged copy
    (a derivative detector at 1024 Hz is dominated by per-sample white noise);
    each peak is then refined to the largest deviation in the full-rate signal."""
    k = max(1, round(FS / 250))
    if k == 1:
        return _detect(x, FS)
    xd = [sum(x[i:i + k]) / k for i in range(0, len(x) - k + 1, k)]
    out, half = [], int(0.1 * FS)
    for p in _detect(xd, FS / k):
        c = p * k + k // 2
        lo, hi = max(0, c - 2 * k), min(len(x), c + 2 * k + 1)
        b0, b1 = max(0, c - half), min(len(x), c + half)
        base = sum(x[b0:b1]) / (b1 - b0)
        out.append(max(range(lo, hi), key=lambda i: abs(x[i] - base)))
    return out


def _detect(x, FS):
    """Very small QRS detector: high-pass, derivative^2, 80 ms integration, adaptive peak pick."""
    n = len(x)
    # high-pass: subtract a 0.2 s moving average
    w = int(0.2 * FS)
    hp = [0.0] * n
    s = 0.0
    for i in range(n):
        s += x[i]
        if i >= w:
            s -= x[i - w]
        hp[i] = x[i] - s / min(i + 1, w)
    # derivative squared, integrated over 80 ms
    iw = int(0.08 * FS)
    e = [0.0] * n
    acc = 0.0
    d2 = [0.0] * n
    for i in range(1, n):
        d = hp[i] - hp[i - 1]
        d2[i] = d * d
        acc += d2[i]
        if i >= iw:
            acc -= d2[i - iw]
        e[i] = acc
    # threshold per 10 s block: 30 % of the block's 98th percentile
    peaks, refr, blk = [], int(0.33 * FS), int(10 * FS)
    last = -refr
    for b0 in range(0, n, blk):
        seg = e[b0:b0 + blk]
        if len(seg) < FS:
            break
        thr = 0.3 * sorted(seg)[int(len(seg) * 0.98)]
        for i in range(b0 + 1, min(n - 1, b0 + blk)):
            if e[i] > thr and e[i] >= e[i - 1] and e[i] > e[i + 1] and i - last >= refr:
                # R = largest |hp| in the preceding 120 ms
                lo = max(0, i - int(0.12 * FS))
                r = max(range(lo, i + 1), key=lambda k: abs(hp[k]))
                if r - last >= refr:
                    peaks.append(r)
                    last = r
    return peaks


def main():
    if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help"):
        print(__doc__.strip())
        return
    if len(sys.argv) > 1:
        ses = sys.argv[1]
    else:
        files = sorted(glob.glob(os.path.join(REC, "ecg_*.csv")), key=os.path.getmtime)
        if not files:
            sys.exit("no recordings found")
        ses = os.path.basename(files[-1])[4:-4]
    print(f"session {ses}")

    global FS
    try:
        with open(os.path.join(REC, f"meta_{ses}.json")) as f:
            FS = int(json.load(f).get("ecg_fs") or FS)
    except (OSError, ValueError):
        pass
    print(f"  ECG sample rate: {FS} Hz")

    ecg = read_csv(os.path.join(REC, f"ecg_{ses}.csv"))
    rr = read_csv(os.path.join(REC, f"rr_{ses}.csv"))
    ecto_path = os.path.join(REC, f"ectopy_{ses}.csv")
    ecto = read_csv(ecto_path) if os.path.exists(ecto_path) else []

    idx = [int(r[1]) for r in ecg]
    x = [float(r[2]) for r in ecg]
    print(f"  ECG samples: {len(x)}  ({len(x) / FS / 60:.1f} min of signal)")

    # 1) BLE packet loss: gaps in the reconstructed sample index (seq * 20)
    lost_pkts, resets = 0, 0
    batch = 20                            # samples per ECG packet
    for a, b in zip(idx, idx[1:]):
        d = b - a
        if d == 1:
            continue
        if 1 < d <= 2 * FS * 60:          # forward gap within 2 min: lost packets
            lost_pkts += (d - 1) // batch
        else:                               # wrap / reconnect / restart
            resets += 1
    total_pkts = len(x) // batch + lost_pkts
    print(f"  BLE packet loss: {lost_pkts} of {total_pkts} ECG packets "
          f"({100 * lost_pkts / max(1, total_pkts):.2f} %), {resets} stream restarts")

    # 2) firmware sample loss: RR from ECG sample count vs firmware RR
    peaks = detect_r(x)
    rr_s = [(b - a) * 1000 / FS for a, b in zip(peaks, peaks[1:])
            if 350 <= (b - a) * 1000 / FS <= 1500 and idx[b] - idx[a] == b - a]
    rr_fw = [float(r[2]) for r in rr if r[2] and 350 <= float(r[2]) <= 1500]
    if len(rr_s) > 20 and len(rr_fw) > 20:
        ms, mf = statistics.median(rr_s), statistics.median(rr_fw)
        eff = FS * ms / mf
        print(f"  median RR: ECG samples {ms:.1f} ms vs firmware {mf:.1f} ms -> "
              f"effective ECG rate {eff:.1f} Hz (sample loss ~{max(0.0, 100 * (1 - eff / FS)):.1f} %)")
    else:
        print("  not enough beats to estimate sample loss")

    # 3) RR irregularity + ectopy
    if len(rr_fw) > 2:
        jumps = sum(1 for a, b in zip(rr_fw, rr_fw[1:]) if abs(b - a) > 0.2 * a)
        print(f"  firmware RR: {len(rr_fw)} beats, successive jumps >20 %: {100 * jumps / (len(rr_fw) - 1):.1f} %")
    if ecto:   # one row per event; the firmware's counters reset on reconnect, so count rows
        hours = len(x) / FS / 3600
        n = {k: sum(1 for r in ecto if r[1] == k) for k in ("PAC", "PVC", "ARTIFACT")}
        print("  ectopy events: " + ", ".join(f"{k} {v} ({v / hours:.0f}/h)" for k, v in n.items()))

if __name__ == "__main__":
    main()
