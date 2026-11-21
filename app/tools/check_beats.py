#!/usr/bin/env python3
"""Check a recording's a1b20006 beats (beat_<session>.csv) against its raw ECG.

    python tools/check_beats.py recordings/beat_20261121_104045.csv

Reports counter gaps (notifications lost), whether r_sample_index only grows,
whether consecutive r_sample_index differences agree with rr_ms, and where
the ECG's R peak lies relative to each beat's ecg_index (largest |ECG -
local median| within +-60 ms). A constant non-zero offset there means the
strap's fiducial delay (R_FIDUCIAL_DELAY_SAMPLES) needs adjusting.
"""
import csv
import json
import os
import statistics
import sys


def main(path):
    d, name = os.path.split(path)
    ses = name[len("beat_"):-len(".csv")]
    beats = list(csv.DictReader(open(path)))
    if not beats:
        print("no beats (firmware without a1b20006?)")
        return
    fs = 500
    try:
        fs = json.load(open(os.path.join(d, f"meta_{ses}.json"))).get("ecg_fs", fs)
    except (OSError, ValueError):
        pass
    cnt = [int(b["counter"]) for b in beats]
    gaps = [(a, b) for a, b in zip(cnt, cnt[1:]) if (b - a) & 0xFFFF != 1]
    ri = [int(b["r_sample_index"]) for b in beats]
    back = sum(1 for a, b in zip(ri, ri[1:]) if b <= a)
    drr = [abs((b - a) * 1000 / fs - float(r["rr_ms"])) for a, b, r in zip(ri, ri[1:], beats[1:])]
    print(f"{len(beats)} beats at {fs} Hz")
    print(f"counter gaps (lost notifications): {len(gaps)}" + (f"  e.g. {gaps[:5]}" if gaps else ""))
    print(f"r_sample_index not increasing: {back}")
    if drr:
        print(f"|index difference - rr_ms|: median {statistics.median(drr):.1f} ms, max {max(drr):.1f} ms"
              " (large ones: beats the strap suppressed or lost between them)")
    want = {int(b["ecg_index"]) for b in beats if b["ecg_index"]}
    if not want:
        print("no beat placed on the ECG (no raw ECG in the connection?)")
        return
    w = round(0.06 * fs)
    need = {k for i in want for k in range(i - 2 * w, i + 2 * w + 1)}
    ecg = {}
    for r in csv.DictReader(open(os.path.join(d, f"ecg_{ses}.csv"))):
        k = int(r["sample_index"])
        if k in need:
            ecg[k] = int(r["adc"])
    offs = []
    for i in sorted(want):
        ctx = [ecg[k] for k in range(i - 2 * w, i + 2 * w + 1) if k in ecg]
        win = [(k, ecg[k]) for k in range(i - w, i + w + 1) if k in ecg]
        if len(ctx) < 3 * w or len(win) < w:
            continue
        m = statistics.median(ctx)
        offs.append(max(win, key=lambda kv: abs(kv[1] - m))[0] - i)
    if not offs:
        print("no ECG around the beats")
        return
    hist = {}
    for o in offs:
        hist[o] = hist.get(o, 0) + 1
    top = sorted(hist.items(), key=lambda kv: -kv[1])[:8]
    print(f"R peak - ecg_index (samples) over {len(offs)} beats: median {statistics.median(offs):+.0f}"
          f" ({1000 * statistics.median(offs) / fs:+.0f} ms); most common {top}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
