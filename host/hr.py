import asyncio, time, json, sys
from bleak import BleakClient
ADDR="D7:CD:02:7A:05:33"
HRM="00002a37-0000-1000-8000-00805f9b34fb"
log=[]
def parse(b):
    f=b[0]; i=1
    if f&1: hr=int.from_bytes(b[1:3],'little'); i=3
    else: hr=b[1]; i=2
    contact = ("n/a" if not f&4 else ("yes" if f&2 else "no"))
    ee=None
    if f&8: ee=int.from_bytes(b[i:i+2],'little'); i+=2
    rr=[]
    if f&16:
        while i+1<len(b): rr.append(int.from_bytes(b[i:i+2],'little')/1024*1000); i+=2
    return f,hr,contact,ee,rr
def cb(_,data):
    f,hr,c,ee,rr=parse(bytes(data))
    t=time.time()
    log.append(dict(t=t,raw=bytes(data).hex(),flags=f,hr=hr,contact=c,rr=rr))
    print(f"{t:.2f} raw={bytes(data).hex():20} HR={hr:3} contact={c} RR={[round(x) for x in rr]}", flush=True)
async def main():
    async with BleakClient(ADDR, timeout=20) as c:
        for s in c.services:
            print("SVC",s.uuid,s.description)
            for ch in s.characteristics:
                v=""
                if "read" in ch.properties:
                    try:
                        r=await c.read_gatt_char(ch); v=r.decode('utf-8') if all(32<=x<127 for x in r) and r else r.hex()
                    except Exception as e: v=f"<{e}>"
                print("   ",ch.uuid,ch.description,ch.properties,v)
        await c.start_notify(HRM,cb)
        await asyncio.sleep(float(sys.argv[1]) if len(sys.argv)>1 else 90)
        await c.stop_notify(HRM)
    json.dump(log,open("hrlog.json","w"))
asyncio.run(main())
