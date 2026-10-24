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

- Scans for the strap **by name** (`Govinda` or `Govinda-XXXX` with the per-chip suffix; pre-v1.0 firmware advertised
  `HRM Raw RR`, which is still matched) — cross-platform and macOS-safe
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
  | ECG info | `a1b20003-…` (read) | u16 sample_hz, u16 raw_batch, u8 sample_bytes, u8 fmt_ver [, u16 acc_div] [, u8 flags: bit0 mains-notched, bit1 60 Hz, bit2 front-end high-pass already compensated] [, u8 compensated corner in 0.1 Hz] — read on connect; absent on older firmware → 250 Hz |
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
  stay raw), big HR number + latest R-R interval (the strip's HR lane shows 60000/RR in bpm),
  a signal-averaged beat from −300 to +1200 ms around the R peak (the first
  beat is the mean, the next beat is the individual beats overlaid, newest sharpest),
  zoomable and measurable like the strip, with Clear and CSV download, per-beat
  equalisation before averaging (own baseline removed, QRS amplitude scaled to the
  median, amplitude / shape outliers rejected), and an
  automatic QRST analysis of the mean beat (`static/qrst.js`: P / QRS / T markers,
  PR, QRS, QT, QTc; optional compensation of the front end's high-pass), live HRV (RMSSD, SDNN, pNN50 over a rolling
  5 min window, ectopic/artifact beats excluded, shown as a ~1 min moving average),
  an HRV trend card (per beat, last 2 min, fills from the left then scrolls:
  RMSSD over the trailing 30 s, |ΔRR| per beat and beat-to-beat HR in bpm), RR/HRV tachogram, accelerometer (X/Y/Z in g, tilt rate in °/s estimated from the turning of the acceleration vector, direction-independent magnitude) + step count,
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

### Mac with two GPUs: the dashboard opens in its own Chrome window

On a MacBook Pro with an integrated and a discrete GPU, Chrome draws the
charts on the integrated one, and there a trace wider than one device pixel
is rasterised on the CPU: on a 2016 15" model (Intel HD 530 + Radeon Pro 450)
the 1.2 px ECG trace kept a whole core busy and the strip at ~42 fps. The page
therefore defaults to software-rendered canvases, one-device-pixel traces and
30 fps, which is cheap on every machine (`?sw=0`, `?lw=1.2`, `?fps=60` in the
URL change each of them).

On the discrete GPU the wide trace costs 11-12 % of a core, but only a switch
on the command line of a newly started Chrome selects that GPU. So when
`app.py` finds Google Chrome and two graphics chipsets on macOS, it opens the
dashboard in a separate Chrome window with its own profile
(`~/Library/Application Support/HRM Raw RR/chrome-profile`),
`--force_high_performance_gpu`, and `?sw=0&lw=1.2`. The discrete GPU draws
more power on battery: `./run.sh --browser default` uses the default browser
instead, and `--browser chrome-gpu` forces the dedicated window on any Mac.

## Reviewing recordings: HRV and fractal analysis

`http://127.0.0.1:8770/review` (the **Recordings** button on the dashboard)
lists the saved sessions. Pick one, drag on the heart-rate chart (or on any
chart below it) to select a period; ◀ ▶ step by the same length, the URL keeps
the session and the period. The session being recorded can be opened too
(⟳ Reload re-reads it).

Before any analysis the beats are checked: out-of-range RRs, runs of 5+
identical RRs (the strap repeating a stale value) and RRs more than 20 % off
the local median (artifacts, ectopic beats) are replaced by the median of the
good beats around them. Breaks where beats were lost (dropped link, lost
notifications) are found from the arrival times; no sliding window spans one.
A window with more corrected beats than "max corrected" gets no value.

Over time (sliding windows, all charts share the time axis):
- RR tachogram with the corrected beats and the strap's PAC / PVC marks,
- DFA α1 (4–16 beats, "window", default 2 min) and α2 (16–64 beats, "MF window"),
- multifractal spectrum width Δα and peak position α0, by MFDFA and by
  Chhabra–Jensen (q = −q … +q, "MF window", default 5 min),
- RMSSD and SDNN, and movement (SD of |a|, 10 s bins) for context.

Chaos or noise (live under the RR histogram, and on the review page):
- Lyapunov divergence curve (Rosenstein) against shuffled and phase-randomised
  surrogates, with the RQA determinism (DET);
- noise titration (Poon & Barahona): Volterra–Wiener models, linear against
  nonlinear (F-test); the white noise (% of the RR SD) needed to hide the
  nonlinearity is the noise limit, 0 = no chaos detected;
- complexity–entropy plane (Bandt–Pompe, Rosso 2007, 4-beat order patterns)
  with the 1/f^k noise curve and chaotic maps for reference.
They run in a Web Worker; on the review page the noise limit and the
complexity above the noise curve are also plotted over time (MF window).

For the selected period: time-domain values, SD1/SD2, α1/α2, the Fq(n)
log-log plot, the f(α) spectra of both methods, h(q) and the Poincaré plot.
Chhabra–Jensen needs a positive measure: |ΔRR| (default) or the RR intervals
(those are nearly uniform, so the spectrum comes out very narrow).

## Daily summary: resting HRV against your own baseline

`http://localhost:8765/daily` (also linked from the dashboard and the review
page). HRV from an arbitrary stretch says little — movement, posture and
talking move it more than recovery does — so this page uses only **resting
windows**: 5 minutes in which the accelerometer shows the strap still (and
the minute before), with no lost beats and at most 5 % corrected beats.
Recordings without accelerometer data (older firmware) are included but shown
hollow; "movement-checked only" leaves them out.

Per window: HR, RMSSD / **lnRMSSD**, SDNN and the **deceleration capacity**
(DC, Bauer 2006: phase-rectified signal averaging of the beats where the
heart slows; vagal, robust to artifacts and trends). Per day (night 21–09 by
default, counted to the morning's date): the median of its windows (DC pooled
over all anchors), a 7-day rolling mean, and the normal range = mean ± 0.5 SD
of the preceding 30 days (from 5 days of data). Days outside it are coloured;
the 7-day mean leaving the band is the meaningful signal. Click a window or a
table row to open it on the review page, which also shows lnRMSSD and DC for
any selected period.

The windows are found on the server (`recordings.rest_windows`), cached per
session; the first load reads all accelerometer files and takes a few seconds.

## Exercise: how much a workout tires you

A card on the live dashboard (over the last 30 min … whole session, every
10 s) and on the review page (for the selected period), from `exercise.js`:

1. **DFA α1 against HR** (Rogers, Gronwald): 2-min windows every 10 s;
   windows where HR changed more than 15 bpm are left out (transients read
   high). A linear fit gives HRVT1 (α1 = 0.75, ~ aerobic threshold) and
   HRVT2 (0.5). Fatigue = lost durability: the last third of the exercise
   gives a lower threshold HR, or a lower α1 at the same HR or at the same
   cadence, than the first.
2. **Decoupling**: cadence/HR, second half against the first, at the
   period's typical cadence (± 8 %); under 5 % is good. Without step data:
   HR drift only.
3. **Heart rate recovery (HRR60)**: HR drop in the 60 s after each bout —
   bouts end where the step counter shows moving turning into standing, or,
   without step data, at HR peaks. Getting smaller through a session: fatigue.
4. **Training load**: Banister and Edwards TRIMP, minutes in the 5 zones.

The verdict counts the four signs. HR max, HR rest and sex (Banister weights)
are set on the card and shared by both pages. Cadence comes from the
strap's step counter (accel CSV, `steps` column), per 10 s bin.

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
├── webserver.py      # aiohttp: serves the dashboard + /ws, the review page + /api/sessions, /daily + /api/rest
├── recordings.py     # reads saved sessions back for the review page (beats, lost-beat breaks, activity + cadence), resting windows for /daily
├── static/           # index.html + app.js + style.css (uPlot via CDN);
│                     # review.html + review.js + hrv.js (HRV / DFA / MFDFA / Chhabra–Jensen)
├── recordings/       # CSV output (created on first run)
├── requirements.txt
├── install.sh / run.sh                 # Linux + macOS installer / launcher
└── install.ps1 / install.bat / run.bat # Windows installer / launcher
```
