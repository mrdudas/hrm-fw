"""Subscribe to the accel char and print x,y,z,steps live. Jump around and
watch if the numbers change (firmware sends accel) or stay constant/absent."""
import asyncio, struct, sys
from bleak import BleakClient, BleakScanner
ADDR="D7:CD:02:7A:05:33"; NAME="HRM Raw RR"
ACC="a1b30002-0000-1000-8000-00805f9b34fb"
n=0
def cb(_,d):
    global n; x,y,z,st=struct.unpack("<hhhH",bytes(d)); n+=1
    if n%5==0: print(f"x={x:6} y={y:6} z={z:6} steps={st}",flush=True)
async def main(dur):
    dev=None
    for _ in range(8):
        for x in await BleakScanner.discover(timeout=5):
            if x.address.upper()==ADDR.upper() or (x.name or "")==NAME: dev=x;break
        if dev: break
    if not dev: print("device not found");return
    async with BleakClient(dev,timeout=20) as c:
        try: await c.start_notify(ACC,cb); print("subscribed to accel, JUMP now...")
        except Exception as e: print("accel subscribe FAILED:",e); return
        await asyncio.sleep(dur)
asyncio.run(main(int(sys.argv[1]) if len(sys.argv)>1 else 30))
