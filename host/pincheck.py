"""Decode the PINCHECK stream: ECG seq carries 0xB000 | (phase<<8) | (p12<<1) | p13.
6 phases (~1s each): P0.12/P0.13 tested as INPUT with NOPULL/PULLUP/PULLDOWN.
Watch the TESTED pin's level (does it follow the pull = floating, or ignore it =
AFE drives it) and the ECG mean (AFE on/off). Run on-body AND off-body."""
import asyncio, struct, sys, time
from collections import defaultdict
from bleak import BleakClient, BleakScanner
ADDR="D7:CD:02:7A:05:33"; NAME="HRM Raw RR"
ECG="a1b20002-0000-1000-8000-00805f9b34fb"
PH={0:"P0.12 NOPULL",1:"P0.12 PULLUP",2:"P0.12 PULLDN",
    3:"P0.13 NOPULL",4:"P0.13 PULLUP",5:"P0.13 PULLDN"}
acc=defaultdict(lambda:{"p12":[], "p13":[], "ecg":[]})
def cb(_,d):
    tag=struct.unpack_from("<H",d,0)[0]
    if (tag & 0xF000)!=0xB000: return
    ph=(tag>>8)&0x0F; p12=(tag>>1)&1; p13=tag&1
    s=[struct.unpack_from("<h",d,i)[0] for i in range(2,len(d),2)]
    a=acc[ph]; a["p12"].append(p12); a["p13"].append(p13); a["ecg"].append(sum(s)/len(s))
def dump():
    print("\n---- phase | tested-pin level | ECG mean (AFE) ----")
    for ph in range(6):
        a=acc[ph]
        if not a["ecg"]: continue
        tested = "p12" if ph<3 else "p13"
        lv = sum(a[tested])/len(a[tested])          # avg level of the tested pin
        em = sum(a["ecg"])/len(a["ecg"])
        print(f"  {PH[ph]:14} | {tested}={lv:.2f} | ECG={em:5.0f}  ({'ON' if em>800 else 'off/flat'})")
    acc.clear()
async def main(dur):
    dev=None
    for _ in range(8):
        for x in await BleakScanner.discover(timeout=5):
            if x.address.upper()==ADDR.upper() or (x.name or "")==NAME: dev=x;break
        if dev: break
    if not dev: print("device not found"); return
    async with BleakClient(dev,timeout=20) as c:
        await c.start_notify(ECG,cb)
        print(f"reading {dur}s — hold ON-BODY for ~8s, then OFF-BODY for ~8s")
        t0=time.time()
        while time.time()-t0<dur:
            await asyncio.sleep(6); dump()
asyncio.run(main(int(sys.argv[1]) if len(sys.argv)>1 else 40))
