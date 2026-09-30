"""Record raw ECG on ONE connection and track the noise level over time.

If the noise/railing comes and goes within a single connection (firmware
constant), it's intermittent hardware/contact. If it's uniformly bad, the
firmware/CPU load is implicated. Per 1 s window we log stddev and % of samples
at the ADC rails (<50 or >4045).

Usage: python raw_noise.py [seconds]
"""
import asyncio, struct, sys, time
from bleak import BleakClient, BleakScanner
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ADDR = "D7:CD:02:7A:05:33"
NAME = "HRM Raw RR"
ECG  = "a1b20002-0000-1000-8000-00805f9b34fb"
FS   = 250.0

async def main(dur):
    d = None
    for _ in range(8):
        for dev in await BleakScanner.discover(timeout=5):
            if dev.address.upper() == ADDR.upper() or (dev.name or "") == NAME:
                d = dev; break
        if d: break
    if not d:
        print("device not found"); return
    samples = []
    def cb(_, data):
        for i in range(2, len(data), 2):
            samples.append(struct.unpack_from("<h", data, i)[0])
    async with BleakClient(d, timeout=20) as c:
        await c.start_notify(ECG, cb)
        print(f"recording raw ECG {dur}s (hold still, don't touch the cable) ...")
        await asyncio.sleep(dur)
        try: await c.stop_notify(ECG)
        except Exception: pass

    s = np.array(samples, float)
    n = len(s)
    print(f"got {n} samples ({n/FS:.1f}s)")
    win = int(FS)  # 1 s windows
    rows = []
    for k in range(0, n - win, win):
        w = s[k:k+win]
        rail = 100.0 * np.mean((w < 50) | (w > 4045))
        rows.append((k/FS, np.std(w), w.min(), w.max(), rail))
    print(f"{'t(s)':>5} {'std':>6} {'min':>5} {'max':>5} {'rail%':>6}")
    for (t, sd, mn, mx, rail) in rows:
        flag = "  <-- RAILING" if rail > 1 else ("  noisy" if sd > 250 else "")
        print(f"{t:>5.0f} {sd:>6.0f} {mn:>5.0f} {mx:>5.0f} {rail:>6.1f}{flag}")

    ts = [r[0] for r in rows]
    fig, ax = plt.subplots(2, 1, figsize=(14, 6), sharex=True)
    ax[0].plot(ts, [r[1] for r in rows], "-o", ms=3)
    ax[0].axhline(250, color="r", ls="--", lw=0.8, label="noisy threshold")
    ax[0].set_ylabel("per-1s std (ADC)"); ax[0].legend(); ax[0].grid(alpha=.3)
    ax[0].set_title("Raw ECG noise over time, one connection, constant firmware")
    ax[1].plot(ts, [r[4] for r in rows], "-o", ms=3, color="#d62728")
    ax[1].set_ylabel("% samples at rail"); ax[1].set_xlabel("t (s)"); ax[1].grid(alpha=.3)
    fig.tight_layout()
    out = "/tmp/claude-1000/-home-zsolt/fa3f28b3-7932-483e-ac9d-8a637c34ff52/scratchpad/raw_noise.png"
    fig.savefig(out, dpi=120); print("wrote", out)

asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 40))
