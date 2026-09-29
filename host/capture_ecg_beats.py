"""Capture raw ECG + HR/RR beat markers together and plot them.

Subscribes to both the raw-ECG characteristic (a1b20002, seq + 20x int16 @250 Hz)
and the standard Heart Rate Measurement (0x2A37, HR + RR). It timestamps every
ECG packet and every beat on arrival, reconstructs an ECG time axis, and draws
the waveform with a vertical marker at each detected beat. Beats whose RR is
suspiciously short (< SHORT_MS, i.e. the "extra" beats behind the short-long
pairs) are drawn in red so we can see if a real QRS sits under them or not.

Usage:  python capture_ecg_beats.py <seconds> [label]
Outputs: raw_<label>.csv, beats_<label>.csv, ecg_<label>.png
"""
import asyncio, struct, sys, time
from bleak import BleakClient, BleakScanner
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

NAME = "HRM Raw RR"
ADDR = "D7:CD:02:7A:05:33"    # fixed strap address (fallback if name scan fails)
ECG  = "a1b20002-0000-1000-8000-00805f9b34fb"
HRM  = "00002a37-0000-1000-8000-00805f9b34fb"
FS   = 250.0
SHORT_MS = 400          # flag beats closer than this (the suspicious "extra" ones)

def parse_hr(b):
    f = b[0]; i = 1
    if f & 1: hr = int.from_bytes(b[1:3], "little"); i = 3
    else:     hr = b[1]; i = 2
    if f & 8: i += 2                       # energy expended, skip
    rr = []
    if f & 16:
        while i + 1 < len(b):
            rr.append(int.from_bytes(b[i:i+2], "little") / 1024 * 1000); i += 2
    return hr, rr

async def main(dur, label):
    d = None
    print("scanning (put the strap on and move it to wake it) ...")
    for attempt in range(8):                     # ~8x5s = up to 40s
        found = await BleakScanner.discover(timeout=5)
        for dev in found:
            if dev.address.upper() == ADDR.upper() or (dev.name or "") == NAME:
                d = dev; break
        if d:
            print(f"found {d.address} ({d.name}) after {(attempt+1)*5}s"); break
        print(f"  not yet visible ({(attempt+1)*5}s) ...")
    if not d:
        print("device never appeared - is it worn/moving?"); return

    ecg = []            # (t_arrival, seq, [20 samples])
    beats = []          # (t_arrival, hr, rr_ms)
    t0 = None

    def ecg_cb(_, data):
        nonlocal t0
        t = time.monotonic()
        if t0 is None: t0 = t
        seq = struct.unpack_from("<H", data, 0)[0]
        s = [struct.unpack_from("<h", data, i)[0] for i in range(2, len(data), 2)]
        ecg.append((t, seq, s))

    def hr_cb(_, data):
        t = time.monotonic()
        hr, rr = parse_hr(bytes(data))
        beats.append((t, hr, rr[-1] if rr else None))

    async with BleakClient(d, timeout=20) as c:
        await c.start_notify(ECG, ecg_cb)
        await c.start_notify(HRM, hr_cb)
        print(f"recording {dur}s ... (get your HR up)")
        await asyncio.sleep(dur)
        try:
            await c.stop_notify(ECG); await c.stop_notify(HRM)
        except Exception:
            pass

    if not ecg:
        print("no ECG received"); return

    # Reconstruct a continuous sample array + time axis from packet seq numbers.
    seq0 = ecg[0][1]
    samples, times = [], []
    for (t, seq, s) in ecg:
        base = ((seq - seq0) & 0xFFFF) * len(s)      # sample index of packet start
        for k, v in enumerate(s):
            idx = base + k
            samples.append(v)
            times.append((ecg[0][0] - t0) + idx / FS)
    samples = np.array(samples, float)
    times   = np.array(times, float)
    # sort by reconstructed time (guard against any packet reordering)
    order = np.argsort(times); times = times[order]; samples = samples[order]

    beat_t  = np.array([b[0] - t0 for b in beats], float)
    beat_rr = [b[2] for b in beats]

    # dump CSVs
    open(f"raw_{label}.csv", "w").write("\n".join(map(str, samples.astype(int))))
    with open(f"beats_{label}.csv", "w") as f:
        f.write("t_s,hr,rr_ms\n")
        for (t, hr, rr) in beats:
            f.write(f"{t-t0:.3f},{hr},{'' if rr is None else round(rr)}\n")

    short = sum(1 for rr in beat_rr if rr is not None and rr < SHORT_MS)
    print(f"[{label}] ecg_samples={len(samples)} dur={times[-1]-times[0]:.1f}s "
          f"beats={len(beats)} short(<{SHORT_MS}ms)={short}")

    # ---- plot: full strip (overview) + a zoom on the first short-RR event ----
    fig, axes = plt.subplots(2, 1, figsize=(16, 8))

    def draw(ax, t_lo, t_hi, title):
        m = (times >= t_lo) & (times <= t_hi)
        ax.plot(times[m], samples[m], lw=0.7, color="#1f77b4")
        for (t, hr, rr) in zip(beat_t, [b[1] for b in beats], beat_rr):
            if not (t_lo <= t <= t_hi): continue
            red = rr is not None and rr < SHORT_MS
            ax.axvline(t, color="#d62728" if red else "#2ca02c",
                       lw=1.4 if red else 0.8, alpha=0.9 if red else 0.5)
            if rr is not None:
                ax.text(t, ax.get_ylim()[1], f"{round(rr)}", fontsize=7,
                        color="#d62728" if red else "#555", rotation=90,
                        va="top", ha="right")
        ax.set_title(title); ax.set_xlabel("t (s)"); ax.set_ylabel("ADC")
        ax.grid(alpha=0.25)

    draw(axes[0], times[0], times[-1],
         f"{label}: full raw ECG with beats (red = RR<{SHORT_MS}ms)")

    # zoom window: centre on the first suspicious short-RR beat, else first beats
    zc = next((t for t, rr in zip(beat_t, beat_rr)
               if rr is not None and rr < SHORT_MS), beat_t[0] if len(beat_t) else times[0])
    draw(axes[1], max(times[0], zc - 3), min(times[-1], zc + 3),
         "zoom on first short-RR event (±3 s)")

    fig.tight_layout()
    fig.savefig(f"ecg_{label}.png", dpi=110)
    print(f"wrote ecg_{label}.png")

asyncio.run(main(int(sys.argv[1]), sys.argv[2] if len(sys.argv) > 2 else "run"))
