"""Decode the pin-probe stream: for each candidate GPIO, in phases
0=input(baseline) 1=drive-LOW 2=drive-HIGH, measure the raw ECG.
If a pin's LOW or HIGH phase makes the ECG go flat (std~0) or slams the
baseline to a rail, that pin gates the AFE.  Wear the strap (live ECG needed).

Usage: python pinprobe.py [seconds]
"""
import asyncio, struct, sys
from collections import defaultdict
from bleak import BleakClient, BleakScanner
import numpy as np

ADDR="D7:CD:02:7A:05:33"; NAME="HRM Raw RR"
CAP="a1b20002-0000-1000-8000-00805f9b34fb"
PH={0:"input",1:"LOW ",2:"HIGH"}
data=defaultdict(list)  # (pin,phase) -> samples

def cb(_,d):
    tag=struct.unpack_from("<H",d,0)[0]
    pin=tag>>8; ph=tag&0xFF
    for i in range(2,len(d),2):
        data[(pin,ph)].append(struct.unpack_from("<h",d,i)[0])

async def main(dur):
    dev=None
    for _ in range(8):
        for x in await BleakScanner.discover(timeout=5):
            if x.address.upper()==ADDR.upper() or (x.name or "")==NAME: dev=x;break
        if dev: break
    if not dev: print("device not found"); return
    async with BleakClient(dev,timeout=20) as c:
        await c.start_notify(CAP,cb)
        print(f"probing {dur}s (wear the strap, stay still) ...")
        await asyncio.sleep(dur)
        try: await c.stop_notify(CAP)
        except Exception: pass

    pins=sorted({p for (p,_) in data})
    print(f"\n{'pin':>4} | {'input std/mean':>16} | {'LOW  std/mean':>16} | {'HIGH std/mean':>16} | flag")
    for p in pins:
        row=[]
        stats={}
        for ph in (0,1,2):
            s=np.array(data.get((p,ph),[]),float)
            if len(s)>30: stats[ph]=(s.std(),s.mean())
            else: stats[ph]=(float('nan'),float('nan'))
        base_std=stats[0][0]
        cells=[]
        flag=""
        for ph in (0,1,2):
            sd,mn=stats[ph]; cells.append(f"{sd:6.0f}/{mn:5.0f}")
            # AFE killed: signal flat (std collapses vs baseline) or baseline railed
            if ph!=0 and sd==sd and base_std==base_std:
                if (base_std>80 and sd<base_std*0.2) or mn<200 or mn>3900:
                    flag=f"<== pin {p} phase {PH[ph]} KILLS/CHANGES ECG"
        print(f"P0.{p:02d} | {cells[0]:>16} | {cells[1]:>16} | {cells[2]:>16} | {flag}")
    print("\n(input = hi-Z baseline w/ QRS; if LOW or HIGH collapses std or rails the mean -> that pin controls the AFE)")

asyncio.run(main(int(sys.argv[1]) if len(sys.argv)>1 else 80))
