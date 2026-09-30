"""Read the ectopy/extrasystole characteristic and print classifications + burden.

Value (LE, 12 B): u8 type, u8 flags, u16 coupling_ms, u16 pause_ms,
                  u16 pvc_count, u16 pac_count, u16 total_beats.
type: 1 = PVC-like (full compensatory pause), 2 = PAC-like (reset/incomplete).

Usage: python ecto.py [seconds]
"""
import asyncio, struct, sys, time
from bleak import BleakClient, BleakScanner

ADDR = "D7:CD:02:7A:05:33"
NAME = "HRM Raw RR"
ECT  = "a1b40002-0000-1000-8000-00805f9b34fb"
TYPES = {0: "-", 1: "PVC", 2: "PAC", 3: "ART"}

def show(data, tag):
    t, fl, coup, pause, pvc, pac, art, tot = struct.unpack("<BBHHHHHH", bytes(data))
    burden = (100.0 * (pvc + pac) / tot) if tot else 0.0
    print(f"{time.strftime('%H:%M:%S')} {tag} type={TYPES.get(t,t):3} "
          f"coupling={coup:4}ms pause={pause:4}ms | PVC={pvc} PAC={pac} "
          f"ART={art} total={tot} burden={burden:.1f}%", flush=True)

async def main(dur):
    d = None
    for _ in range(8):
        for dev in await BleakScanner.discover(timeout=5):
            if dev.address.upper() == ADDR.upper() or (dev.name or "") == NAME:
                d = dev; break
        if d: break
        print("scanning (wear + move the strap) ...")
    if not d:
        print("device not found"); return
    async with BleakClient(d, timeout=20) as c:
        val = await c.read_gatt_char(ECT)
        show(val, "READ ")
        await c.start_notify(ECT, lambda _, v: show(v, "EVENT"))
        print(f"listening {dur}s for extrasystoles ...")
        await asyncio.sleep(dur)
        val = await c.read_gatt_char(ECT)
        show(val, "FINAL")

asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 180))
