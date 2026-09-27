# Host-side tools

Python BLE + analysis helpers (run in a venv with `bleak numpy scipy matplotlib`):

- `scan.py`        — BLE scan, marks Heart-Rate-service devices
- `hr.py`          — connect + log HR + RR from the Heart Rate Measurement (0x2A37)
- `capture.py`     — subscribe to the raw-ECG stream (name "HRM Capture")
- `capture2.py`    — raw-ECG stream from the merged firmware (name "HRM Raw RR", char a1b20002)
- `openocd_nrf52_unlock.cfg` — OpenOCD (dapdirect_swd) CTRL-AP mass-erase; used to unlock
  the APPROTECT-locked nRF52 via a CMSIS-DAP probe (an ST-Link V3 cannot do this).

Flashing uses pyOCD: `pyocd flash -t nrf52 build/zephyr/zephyr.hex` (CMSIS-DAP probe,
e.g. an RP2040 running debugprobe firmware; SWDIO->F1, SWCLK->G1, GND->GND).
