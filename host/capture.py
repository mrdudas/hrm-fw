import asyncio, struct, time
from bleak import BleakClient, BleakScanner
NAME="HRM Capture"
CHR="a1b20002-0000-1000-8000-00805f9b34fb"
samples=[]; seqs=[]
def cb(_,data):
    seq=struct.unpack_from("<H",data,0)[0]; seqs.append(seq)
    for i in range(2,len(data),2):
        samples.append(struct.unpack_from("<h",data,i)[0])
async def main(dur=20):
    print("scanning for",NAME)
    d=await BleakScanner.find_device_by_name(NAME,timeout=12)
    if not d: print("not found"); return
    print("connecting",d.address)
    async with BleakClient(d,timeout=20) as c:
        await c.start_notify(CHR,cb)
        print(f"capturing {dur}s...")
        await asyncio.sleep(dur)
    # detect drops
    drops=sum(1 for a,b in zip(seqs,seqs[1:]) if (b-a)&0xffff!=1)
    print(f"packets={len(seqs)} samples={len(samples)} drops={drops}")
    with open("raw_ecg.csv","w") as f:
        f.write("idx,adc\n")
        for i,s in enumerate(samples): f.write(f"{i},{s}\n")
    print("saved raw_ecg.csv (fs=250 Hz)")
asyncio.run(main(20))
