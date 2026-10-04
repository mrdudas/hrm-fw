# HRM Raw RR — desktop dashboard + recorder

A small, cross-platform (macOS / Linux / Windows) desktop app that connects to
the custom **"HRM Raw RR"** BLE chest strap, records **every** data stream to CSV
on disk, and serves a live browser dashboard with charts.

It is a single Python process (asyncio): `bleak` for BLE and `aiohttp` for a
local web server + WebSocket. The frontend is plain HTML/JS using **uPlot** (canvas charts, loaded from a CDN) — no build
step. The live strip is redrawn every animation frame. Each stream's timestamps
come from a clock fitted to sample index vs arrival time (`static/clock.js`)
that never jumps, and the playout delay adapts to the host's real BLE jitter
(~0.3 s normally, more on hosts that stall, e.g. MacBooks where Wi-Fi and
Bluetooth share a radio), so the bursty packets scroll smoothly.

## What it does

- Scans for the strap **by name** (`HRM Raw RR`) — cross-platform and macOS-safe
  (macOS exposes opaque UUIDs, not MAC addresses). If it isn't found, it scans
  again **every minute** (the dashboard shows a countdown).
- **Device picker in the dashboard header**: every scan fills a dropdown with
  nearby devices (the strap is starred). Pick one and press **Connect**, or keep
  *Auto* to find the strap by name; **⟳ Scan** refreshes the list. The choice is
  remembered in `device.json` (`--address` overrides it). **Disconnect** drops
  the link and stops scanning until you press Connect again.
- Subscribes to all streams, tolerating any that are missing on older firmware:
  | Stream   | Characteristic UUID | Payload |
  |----------|---------------------|---------|
  | HR / RR  | `0x2A37`            | flags + HR + RR intervals (1/1024 s → ms) |
  | Raw ECG  | `a1b20002-…`        | uint16 seq + 20× int16 @ 250 or 1024 Hz |
  | ECG info | `a1b20003-…` (read) | u16 sample_hz, u16 raw_batch, u8 sample_bytes, u8 fmt_ver — read on connect; absent on older firmware → 250 Hz |
  | Accel    | `a1b30002-…`        | ~25 Hz; legacy int16 x/y/z + u16 steps (8 B), or batched `u8 n, n×(x,y,z), u16 steps[, u16 ecg_seq, u8 ecg_off]` — v2 carries the ECG position of the last sample, so accel is drawn on the ECG clock |
  | Ectopy   | `a1b40002-…`        | PVC/PAC/artifact classifier + burden |
  | Battery  | `0x2A19`            | 1 byte percent (read + notify) |
- **Auto-reconnects** if the BLE link drops (quick retry, then once a minute).
- Records each stream to a timestamped CSV in `recordings/`, flushed after every
  packet so a crash loses at most the last one:
  - `ecg_<session>.csv` — `unix_time, sample_index, adc, rx_time` (`rx_time` = host
    arrival time of the sample's BLE packet; lets `tools/analyze_recording.py`
    measure the real sample rate)
  - `rr_<session>.csv` — `unix_time, hr_bpm, rr_ms`
  - `accel_<session>.csv` — `unix_time, x, y, z, steps, ecg_index` (`ecg_index` =
    the sample's position in the ECG `sample_index` space, with v2 firmware)
  - `ectopy_<session>.csv` — `unix_time, type, coupling_ms, pause_ms, pvc, pac, artifact, total, burden_pct`
  - `battery_<session>.csv` — `unix_time, pct`
  - `meta_<session>.json` — `{"ecg_fs": …}`, the ECG sample rate used for the
    session (read by `tools/analyze_recording.py`)
- Live dashboard at **http://localhost:8770** (opened automatically): rolling
  ECG waveform (optional 50/60 Hz mains notch on the display only — recordings
  stay raw), big HR number + beat-to-beat HR (60000/RR, also as the strip's HR lane),
  a signal-averaged beat with Clear and CSV download (mean + SD per sample), live HRV (RMSSD, SDNN, pNN50 over a rolling
  5 min window, ectopic/artifact beats excluded, shown as a ~1 min moving average),
  an HRV trend card (RMSSD per minute, 5 min moving average and the live smoothed
  value over the whole session), RR/HRV tachogram, accelerometer + step count,
  ectopy counts / burden / event log, and battery. Dark theme. The page
  reconnects its WebSocket by itself if you reload it.

## Install

Needs **Python 3.10+**. The install scripts create a local `.venv`, install the
requirements and check that Bluetooth is usable:

| OS            | Install                                   | Start                    |
|---------------|-------------------------------------------|--------------------------|
| Linux / macOS | `./install.sh`                            | `./run.sh`               |
| Windows       | double-click `install.bat` (or `.\install.ps1`) | `run.bat`         |

Options of `app.py` pass straight through the start scripts, e.g.
`./run.sh --demo` or `run.bat --port 9000`. Re-running the installer reuses the
existing `.venv`; `--force` (Windows: `-Force`) rebuilds it.

Manual install, if you prefer:

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
python app.py --demo --demo-fs 1024   # same, simulating the 1024 Hz firmware
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
├── requirements.txt
├── install.sh / run.sh                 # Linux + macOS installer / launcher
└── install.ps1 / install.bat / run.bat # Windows installer / launcher
```
