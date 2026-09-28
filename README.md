# hrm-fw — custom firmware for a HRM Belt (nRF52805)

Open replacement firmware for the **"HRM Belt" chest strap** (a Magene
OEM design built around a Nordic **nRF52805**). The stock firmware reports a
**fake RR interval** (`RR = floor(60000 / HR)`), which is useless for HRV. This
firmware measures and broadcasts the **true beat-to-beat RR interval** over the
standard BLE Heart Rate Service — turning a cheap strap into a real HRV sensor —
and adds raw-ECG streaming, accelerometer + step data, motion-wake deep sleep and
dual-host connections.

> Built by reverse-engineering the owner's own strap. **Not a medical device.**
> See [Safety](#safety--disclaimer).

## Features
- ✅ **Real HR + RR / HRV** on the standard **Heart Rate Service (0x180D)** — works
  with any HRV app (validated ~63 bpm, RMSSD ~15 ms; the stock firmware's RMSSD ≈ 0).
- ✅ **Raw ECG streaming** over a custom characteristic.
- ✅ **Raw accelerometer (X/Y/Z) + step count** (discovered on-board Silan SC7A20).
- ✅ **Motion-wake deep sleep** — off-body → System OFF (~µA); movement wakes it.
- ✅ **Two simultaneous BLE hosts** (e.g. a phone and a bike/rowing computer).
- ✅ **Status LED** (wake blink + heartbeat pulse).
- ✅ Clean QRS detector: **50 Hz notch + 8–22 Hz band-pass + adaptive threshold**.

## The device (reverse-engineered hardware map)
| Item | Value |
|---|---|
| MCU | Nordic **nRF52805** (WLCSP, Cortex-M4 **no FPU**, 24 KB RAM / 192 KB flash) |
| ECG analog front end | **RS8034** quad op-amp (+ TJ89127) |
| Heartbeat analog input | **P0.05 / AIN3** (ball **F6**) |
| SWD | **SWDIO = F1**, **SWDCLK = G1** |
| Accelerometer | **Silan SC7A20** (LIS2DH/LIS3DH-compatible), I²C **SCL=P0.16, SDA=P0.18, addr 0x19**, WHO_AM_I `0x11` |
| Accel motion INT | wired to **P0.14** (active-high) → used for motion-wake |
| Status LED | **P0.04** (active-high) |
| Clocks | 32 MHz + 32.768 kHz crystals |

## Repository layout
```
src/               main firmware (HR/RR + raw ECG + accel/steps + power mgmt)
boards/hrm_belt/   custom Zephyr board for the SoC nrf52805
capture/           raw-ECG-only streaming variant
accel/  i2cscan/  intfind/  ledfind/   hardware bring-up / discovery apps
tools/             pyOCD unlock + flash scripts, build helper
host/              BLE capture + analysis Python scripts (bleak/numpy/scipy)
docs/ultimate-belt.md   v2 hardware design (nRF52840/nRF5340, real AFE, GPS, Holter…)
```

## Requirements
- **Zephyr 4.4.x** workspace + the **Zephyr SDK** (arm-zephyr-eabi).
- A **CMSIS-DAP** debug probe — e.g. an **RP2040** flashed with the official
  `debugprobe_on_pico.uf2`. ⚠️ An **ST-Link cannot unlock this chip** (see below).
- **pyOCD** (`pip install pyocd`) and, for the one-time unlock, **OpenOCD 0.12+**.
- Python + `bleak numpy scipy matplotlib` for the host scripts.

Wire the probe to the strap: `SWDIO→F1`, `SWDCLK→G1`, `GND→GND` (CMSIS-DAP needs
no target-VCC sense).

## Build
```bash
# in a Zephyr environment (ZEPHYR_BASE set, SDK/toolchain available)
west build -p auto -b hrm_belt --build-dir build . -- -DBOARD_ROOT=$PWD
# or: tools/BUILD.sh   (adjust the ZEPHYR_BASE / CROSS_COMPILE paths inside)
```

## Unlock + flash
The stock chip has **APPROTECT** readback protection enabled. Unlocking **mass-
erases** the stock firmware (irreversible — it can't be read out first).

```bash
# 1) one-time unlock via CTRL-AP (needs a CMSIS-DAP probe; an ST-Link CANNOT do this)
pyocd erase -t nrf52 --mass          # or OpenOCD dapdirect_swd CTRL-AP ERASEALL
# 2) flash
pyocd flash -t nrf52 build/zephyr/zephyr.hex
```
See `tools/00_check_lock.sh` … `03_flash.sh`. If pyOCD's mass-erase can't reach
the CTRL-AP, use the OpenOCD `dapdirect_swd` recipe in `host/openocd_nrf52_unlock.cfg`.

## BLE API
Advertises as **`HRM Raw RR`** (up to 2 simultaneous connections).

| Service / characteristic | UUID | Data |
|---|---|---|
| Heart Rate Measurement | `0x2A37` | flags + HR (u8) + **RR (u16, 1/1024 s)** |
| Body Sensor Location | `0x2A38` | `0x01` (chest) |
| Raw ECG (custom) | `a1b20002-…` | seq (u16) + 20× ECG samples (i16, 250 Hz) |
| Accel + steps (custom) | `a1b30002-…` | X,Y,Z (i16) + steps (u16), ~25 Hz |

Read them with the scripts in `host/` (e.g. `hr.py`, `capture2.py`).

## Power behaviour
Worn → measures + advertises. Off-body & still for 60 s (or after a 3 h session)
→ **System OFF** (motion INT armed on P0.14). Any movement → wake → re-check for a
heartbeat → active if worn, else back to sleep. LED double-blinks on wake.

## v2 — "Ultimate Belt"
A ground-up successor design (real ECG AFE, FPU MCU for wavelet/adaptive filtering,
6-axis IMU, GPS, offline logging, wireless charging, OTA, and a Civilian vs PRO
Holter split) lives in **[`docs/ultimate-belt.md`](docs/ultimate-belt.md)**.

## Safety / disclaimer
This is a **DIY project on the owner's own hardware**, for research and personal
use. It is **not a medical device**, provides no diagnosis, and must not be relied
on for any clinical purpose. Replacing the manufacturer firmware and unlocking the
chip **voids any warranty** and **irreversibly erases** the original firmware.
Do not wear the strap while charging from mains-referenced equipment. Use at your
own risk.

## License
[MIT](LICENSE).
