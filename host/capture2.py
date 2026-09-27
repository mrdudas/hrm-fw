import asyncio, struct, sys, statistics
from bleak import BleakClient, BleakScanner
NAME="HRM Raw RR"; CHR="a1b20002-0000-1000-8000-00805f9b34fb"
async def main(dur, label):
    d=await BleakScanner.find_device_by_name(NAME,timeout=12)
    if not d: print("not found"); return
    s=[]
    def cb(_,data):
        for i in range(2,len(data),2): s.append(struct.unpack_from("<h",data,i)[0])
    async with BleakClient(d,timeout=20) as c:
        await c.start_notify(CHR,cb)
        await asyncio.sleep(dur)
    if s:
        print(f"[{label}] n={len(s)} min={min(s)} max={max(s)} mean={statistics.mean(s):.0f} std={statistics.pstdev(s):.0f} p2p={max(s)-min(s)}")
        open(f"raw_{label}.csv","w").write("\n".join(map(str,s)))
asyncio.run(main(int(sys.argv[1]),sys.argv[2]))
