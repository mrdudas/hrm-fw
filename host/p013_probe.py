#!/usr/bin/env python3
"""Drive P0.13 over BLE to probe its role in the analog front-end.

Writes one byte to the diagnostic characteristic a1b20005:
  0 = input, no pull (float -- current/native)
  1 = input, pull-down
  2 = input, pull-up
  3 = drive LOW
  4 = drive HIGH

Usage:  python3 host/p013_probe.py <0-4>
Watch the ECG baseline/noise (scope + dashboard) after each write to see which
state cleans it up (that's what P0.13 wants) or breaks the signal."""
import sys
import asyncio
from bleak import BleakScanner, BleakClient

PROBE_UUID = "a1b20005-0000-1000-8000-00805f9b34fb"
NAME = "HRM Raw RR"
LABEL = {0: "float (NOPULL)", 1: "pull-down", 2: "pull-up", 3: "drive LOW", 4: "drive HIGH"}

async def main(mode):
    print(f"scanning for {NAME!r} ...")
    dev = await BleakScanner.find_device_by_filter(
        lambda d, ad: (ad.local_name or d.name) == NAME, timeout=15.0)
    if not dev:
        print("not found (shake the strap to wake it)"); return 1
    async with BleakClient(dev) as c:
        await c.write_gatt_char(PROBE_UUID, bytes([mode]), response=True)
        print(f"P0.13 -> mode {mode} = {LABEL.get(mode, '?')}")
    return 0

if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("0", "1", "2", "3", "4"):
        print(__doc__); sys.exit(2)
    sys.exit(asyncio.run(main(int(sys.argv[1]))))
