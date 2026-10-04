#!/usr/bin/env python3
"""Monitor the P0.12 contact line and the ECG (AD) live, to watch on/off-body.

Every ~1.5 s: read a1b20004 (byte 9 = live P0.12 level) and print it with the ECG
mean/std/peak-to-peak over the last window. Take the strap off the chest partway
through and watch P0.12 go 1 -> 0 and the AD go flat (AFE self-gates off)."""
import sys, asyncio, time, statistics as st, struct
from bleak import BleakScanner, BleakClient

NAME="HRM Raw RR"
ECG ="a1b20002-0000-1000-8000-00805f9b34fb"
LINK="a1b20004-0000-1000-8000-00805f9b34fb"

async def main(secs):
    dev=await BleakScanner.find_device_by_filter(
        lambda d,ad:(ad.local_name or d.name)==NAME, timeout=15.0)
    if not dev: print("not found (shake the strap)"); return
    async with BleakClient(dev) as c:
        s=[]
        c_ecg=lambda _,d:[s.append(struct.unpack_from("<h",d,i)[0]) for i in range(2,len(d)-1,2)]
        await c.start_notify(ECG, c_ecg)
        print(f"{'t':>4} {'P0.12':>5} {'n':>4} {'mean':>6} {'std':>7} {'p2p':>6}  AFE")
        t0=time.time()
        while time.time()-t0 < secs:
            s.clear(); await asyncio.sleep(1.5); d=list(s)
            link=await c.read_gatt_char(LINK)
            lvl=link[9] if len(link)>=10 else -1
            if len(d)<10:
                print(f"{time.time()-t0:4.0f} {lvl:>5}  (no ECG data)"); continue
            sd=st.pstdev(d)
            afe = "ON (signal)" if sd>20 else "off (flat)"
            print(f"{time.time()-t0:4.0f} {lvl:>5} {len(d):>4} {st.mean(d):6.0f} {sd:7.1f} {max(d)-min(d):6d}  {afe}")
        await c.stop_notify(ECG)

if __name__=="__main__":
    asyncio.run(main(int(sys.argv[1]) if len(sys.argv)>1 else 45))
