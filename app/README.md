# HRM Raw RR — desktop dashboard + recorder

A small, cross-platform (macOS / Linux / Windows) desktop app that connects to
the custom **"HRM Raw RR"** BLE chest strap, records **every** data stream to CSV
on disk, and serves a live browser dashboard with charts.

It is a single Python process (asyncio): `bleak` for BLE and `aiohttp` for a
local web server + WebSocket. The frontend is plain HTML/JS using **uPlot** (canvas charts, loaded from a CDN) — no build
step. The live strip is redrawn every animation frame with a 0.35 s playout
delay, and each stream's timestamps come from a fit of sample index vs arrival
time, so the bursty BLE packets scroll smoothly instead of jumping.

## What it does

- Scans for the strap **by name** (`HRM Raw RR`) — cross-platform and macOS-safe
  (macOS exposes opaque UUIDs, not MAC addresses). Falls back to a terminal
  device picker, or you can pass `--address`.
- Subscribes to all streams, tolerating any that are missing on older firmware:
  | Stream   | Characteristic UUID | Payload |
  |----------|---------------------|---------|
  | HR / RR  | `0x2A37`            | flags + HR + RR intervals (1/1024 s → ms) |
  | Raw ECG  | `a1b20002-…`        | uint16 seq + 20× int16 @ 250 Hz |
  | Accel    | `a1b30002-…`        | int16 x/y/z + uint16 steps @ ~25 Hz |
  | Ectopy   | `a1b40002-…`        | PVC/PAC/artifact classifier + burden |
  | Battery  | `0x2A19`            | 1 byte percent (read + notify) |
- **Auto-reconnects** if the BLE link drops.
- Records each stream to a timestamped CSV in `recordings/`, flushed after every
  packet so a crash loses at most the last one:
  - `ecg_<session>.csv` — `unix_time, sample_index, adc`
  - `rr_<session>.csv` — `unix_time, hr_bpm, rr_ms`
  - `accel_<session>.csv` — `unix_time, x, y, z, steps`
  - `ectopy_<session>.csv` — `unix_time, type, coupling_ms, pause_ms, pvc, pac, artifact, total, burden_pct`
  - `battery_<session>.csv` — `unix_time, pct`
- Live dashboard at **http://localhost:8770** (opened automatically): rolling
  ECG waveform, big HR number + RR, RR/HRV tachogram, accelerometer + step count,
  ectopy counts / burden / event log, and battery. Dark theme. The page
  reconnects its WebSocket by itself if you reload it.

## Install

Use a virtual environment:

```bash
cd ~/hrm-fw/app
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Run

```bash
python app.py               # scan for the strap, stream live, open the dashboard
python app.py --demo        # synthetic data — no hardware needed (great for UI testing)
python app.py --scan        # just list nearby BLE devices and exit
python app.py --address D7:CD:02:7A:05:33   # connect to a specific address / macOS UUID
python app.py --no-open --port 9000         # don't open a browser, custom port
```

Then open http://localhost:8770 (done automatically unless `--no-open`).
Wear the strap and move it a little to wake it if the scan doesn't find it.

### Demo mode

`--demo` streams a plausible synthetic ECG (250 Hz), HR/RR beats with
respiratory sinus arrhythmia, accelerometer motion + steps, occasional
PVC/PAC ectopic beats, and a draining battery. It exercises the entire
dashboard and the CSV recorder without any hardware.

## Platform notes

- **Linux** — needs BlueZ with `bluetoothd` running (`systemctl status bluetooth`).
  Scanning normally works as a normal user; if not, ensure your user can access
  BlueETH (e.g. the `bluetooth` group) or run with appropriate capabilities.
- **macOS** — the first run prompts for Bluetooth permission; grant it to the
  terminal / app. macOS uses opaque device UUIDs, so discovery is by name (this
  app already does that).
- **Windows** — Windows 10 (build 16299+) / 11 work out of the box via WinRT.

## Packaging (optional, later)

Can be bundled into a single executable with PyInstaller, e.g.:

```bash
pip install pyinstaller
pyinstaller --onefile --add-data "static:static" app.py   # Windows: use ';' instead of ':'
```

The `static/` folder (index.html, app.js, style.css) must ship alongside the
binary — the `--add-data` flag above does that.

## Files

```
app/
├── app.py            # entry point: CLI, wires server + data source, opens browser
├── config.py         # UUIDs, device name, sample rates
├── parsers.py        # exact byte-layout parsers (match ~/hrm-fw/host/)
├── recorder.py       # per-stream CSV writer (flushes every packet)
├── hub.py            # fans events out to CSV + all WebSocket clients
├── ble_source.py     # scan / connect / subscribe / auto-reconnect (bleak)
├── demo_source.py    # synthetic data generator (--demo)
├── webserver.py      # aiohttp: serves the dashboard + /ws
├── static/           # index.html + app.js + style.css (uPlot via CDN)
├── recordings/       # CSV output (created on first run)
└── requirements.txt
```
