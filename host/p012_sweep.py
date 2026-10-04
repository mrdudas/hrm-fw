#!/usr/bin/env python3
"""Probe P0.12 (the AFE contact/lead-off line) and measure the ECG at each state.

SAFE modes only by default (float, pull-down, pull-up) — no hard drive against a
possible AFE output. For each: write [12, mode], read a1b20004 (P0.12 live level +
link params), capture the ECG, report. If P0.12 is a strong AFE output a weak pull
won't move it (level stays, AD unchanged); if a pull-down drops the level and the
ECG dies, P0.12 gates the AFE (enable input). Restores float at the end.

Usage: python3 host/p012_sweep.py [modes]   e.g. "0 1 2" (default) or "0 3 4" to
also hard-drive (only after the safe sweep, and be ready to abort)."""
import sys, asyncio, statistics as st, struct
from bleak import BleakScanner, BleakClient

NAME="HRM Raw RR"
ECG  ="a1b20002-0000-1000-8000-00805f9b34fb"
LINK ="a1b20004-0000-1000-8000-00805f9b34fb"
PROBE="a1b20005-0000-1000-8000-00805f9b34fb"
LABEL={0:"float",1:"pulldown",2:"pullup",3:"driveLOW",4:"driveHI"}

async def main(modes):
    dev=await BleakScanner.find_device_by_filter(
        lambda d,ad:(ad.local_name or d.name)==NAME, timeout=15.0)
    if not dev: print("not found (shake the strap)"); return
    async with BleakClient(dev) as c:
        s=[]
        c_ecg=lambda _,d:[s.append(struct.unpack_from("<h",d,i)[0]) for i in range(2,len(d)-1,2)]
        await c.start_notify(ECG, c_ecg)
        print(f"{'P0.12 mode':12} {'lvl':>3} {'n':>5} {'mean':>7} {'std':>7} {'p2p':>6}")
        for m in modes+[0]:
            await c.write_gatt_char(PROBE, bytes([12, m]), response=True)
            await asyncio.sleep(1.5)
            link=await c.read_gatt_char(LINK)
            lvl=link[9] if len(link)>=10 else -1
            s.clear(); await asyncio.sleep(3.0); d=list(s)
            if len(d)<10: print(f"{LABEL[m]:12} {lvl:>3}  (no data)"); continue
            print(f"{LABEL[m]:12} {lvl:>3} {len(d):>5} {st.mean(d):7.0f} {st.pstdev(d):7.1f} {max(d)-min(d):6d}")
        await c.stop_notify(ECG)
    print("restored P0.12 -> float (0)")

if __name__=="__main__":
    modes=[int(x) for x in sys.argv[1:]] or [0,1,2]
    asyncio.run(main(modes))
