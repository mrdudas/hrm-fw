import asyncio
from bleak import BleakScanner
HR="0000180d-0000-1000-8000-00805f9b34fb"
async def main():
    devs = await BleakScanner.discover(timeout=10, return_adv=True)
    for addr,(d,adv) in sorted(devs.items(), key=lambda x:-x[1][1].rssi):
        mark = "  <-- HEART RATE" if HR in [u.lower() for u in adv.service_uuids] else ""
        print(f"{addr} rssi={adv.rssi:4} name={adv.local_name or d.name}{mark}")
asyncio.run(main())
