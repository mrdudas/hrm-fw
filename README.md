# Decathlon HRM Belt — raw-RR custom firmware (nRF52805)

Replace the stock Magene firmware (smoothed HR + **fake** RR = `floor(60000/HR)`)
with firmware that measures and broadcasts the **true beat-to-beat RR interval**
over standard BLE Heart Rate Service — so the strap becomes HRV-capable.

## Hardware facts (reverse-engineered)
| Item | Value |
|---|---|
| MCU | Nordic **nRF52805** (WLCSP, 24 KB RAM / 192 KB flash) |
| Analog front end | **RS8034** quad op-amp (discrete ECG amp) + TJ89127 |
| Heartbeat signal into MCU | **P0.05 / AIN3 = ball F6** |
| SWD | **SWDIO = F1**, **SWDCLK = G1** |
| Clocks | 32 MHz (XC1/XC2) + 32.768 kHz (P0.00/01) — both present |
| Debug probe | ST-Link V3 MINIE (STDC14 CN4) |

### Wiring: ST-Link V3 MINIE **CN2 side/edge connector** → strap
(UM2910 Table 3. Pads split TOP=1-5, BOTTOM=6-10.)
| CN2 pin | signal | strap |
|---|---|---|
| 3 (TOP) | SWDIO | **F1** |
| 4 (TOP) | SWCLK | **G1** |
| 6 (BOTTOM) | GND | battery − |
| 10 (BOTTOM) | T_VCC (sense) | VDD / battery + (~3 V) |

Leave the strap on its own battery. The CN2 edge connector has **no GNDDETECT
pin** — so T_VCC (pin 10) is what tells the probe a target is present; without it
the V3 won't drive the bus (the usual "edge connector SWD not working" cause).

(If using the CN4 STDC14 header instead: SWDIO=2, SWCLK=4, GND=3/5, T_VCC=1,
and there you must also tie GNDDETECT=11 to GND.)

## Two paths (decided by `tools/00_check_lock.sh`)
1. **UNLOCKED** → `01_dump.sh` backs up the stock firmware, then we patch out the
   smoothing and reflash — stock firmware preserved. (Best case.)
2. **LOCKED (APPROTECT)** → `02_recover.sh` mass-erases (stock firmware lost for
   good), then we flash *this* firmware. (This project is that firmware.)

## Order of operations (tomorrow)
```
tools/00_check_lock.sh     # read-only: probe visible? locked?
# if unlocked:
tools/01_dump.sh           # save magene_flash.bin (do this before anything!)
# to run our firmware:
tools/BUILD.sh             # compile
tools/02_recover.sh        # ONLY if locked — erases stock fw (asks to confirm)
tools/03_flash.sh          # program our firmware
tools/rtt.sh               # watch live logs: raw samples, beats, RR
```

## Firmware design (`src/main.c`)
- SAADC samples AIN3 at 500 Hz.
- Adaptive-threshold R-peak detector (baseline removal + envelope + 280 ms
  refractory), each beat timestamped with the CPU cycle counter.
- Emits standard **Heart Rate Measurement (0x2A37)** with the **RR-interval bit set**,
  RR in 1/1024 s units — the real interval, never recomputed from HR.
- HR shown is a short median of recent RRs (display only; the transmitted RR is raw).
- Logs go over **SEGGER RTT** (no UART pins on the WLCSP).

## Status / caveats
- RAM is tight (24 KB). `prj.conf` is trimmed; if the link overflows, trim further.
- Board files assume in-tree names `nordic/nrf52805_caaa.dtsi` and
  `SOC_NRF52805_CAAA` — verified at build.
- First bring-up goal: open `rtt.sh` and confirm the raw waveform looks like an ECG
  and beats land on real heartbeats. Tune thresholds if needed, then trust the RR.
