"""BLE data source: scan, connect, subscribe to every stream, auto-reconnect.

`bleak` is imported lazily so demo mode and the web UI work without it installed.
Discovery is name-based (cross-platform, macOS-safe); a terminal picker is the
fallback when the named device is not found.
"""
import asyncio
import sys

from config import (DEVICE_NAME, KNOWN_ADDRESS, HR_UUID, ECG_UUID, ACCEL_UUID,
                    ECTOPY_UUID, BATTERY_UUID)
import parsers


async def scan_devices(timeout=6):
    """Return list of (address, name, rssi) for all advertising devices."""
    from bleak import BleakScanner
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    out = []
    for addr, (dev, adv) in found.items():
        out.append((addr, adv.local_name or dev.name or "?", adv.rssi))
    out.sort(key=lambda x: -(x[2] if x[2] is not None else -999))
    return out


async def find_device(name=DEVICE_NAME, address=None, attempts=6, timeout=5,
                      log=print):
    """Locate the strap. Prefer explicit address, then name match, then a picker."""
    from bleak import BleakScanner
    want_addr = (address or "").upper()
    for attempt in range(attempts):
        log(f"scanning ({(attempt + 1) * timeout}s) for '{name}' ...")
        found = await BleakScanner.discover(timeout=timeout, return_adv=True)
        candidates = []
        for addr, (dev, adv) in found.items():
            nm = adv.local_name or dev.name or ""
            if want_addr and addr.upper() == want_addr:
                return dev
            if not address and (nm == name or addr.upper() == KNOWN_ADDRESS.upper()):
                return dev
            candidates.append((addr, nm, adv.rssi, dev))
        # named device not seen; if user is at a TTY, let them pick
        if candidates and sys.stdin and sys.stdin.isatty():
            dev = _terminal_picker(candidates, log)
            if dev is not None:
                return dev
    return None


def _terminal_picker(candidates, log):
    candidates = sorted(candidates, key=lambda x: -(x[2] or -999))
    print("\nDevice not found by name. Nearby BLE devices:")
    for i, (addr, nm, rssi, _dev) in enumerate(candidates):
        print(f"  [{i}] {addr}  rssi={rssi}  {nm}")
    try:
        sel = input("Pick a number (or Enter to keep scanning): ").strip()
    except EOFError:
        return None
    if sel.isdigit() and int(sel) < len(candidates):
        return candidates[int(sel)][3]
    return None


class BLESource:
    def __init__(self, hub, name=DEVICE_NAME, address=None, log=print):
        self.hub = hub
        self.name = name
        self.address = address
        self.log = log
        self._stop = asyncio.Event()

    def stop(self):
        self._stop.set()

    async def run(self):
        """Outer loop: (re)discover, connect, stream, reconnect with backoff."""
        from bleak import BleakClient
        backoff = 2
        while not self._stop.is_set():
            self.hub.publish_status("scanning")
            dev = await find_device(self.name, self.address, log=self.log)
            if dev is None:
                self.log("device not found; retrying ...")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)
                continue
            backoff = 2
            self.log(f"connecting to {getattr(dev, 'address', dev)} "
                     f"({getattr(dev, 'name', '')}) ...")
            try:
                await self._session(BleakClient, dev)
            except Exception as e:
                self.log(f"BLE session error: {e!r}")
            if not self._stop.is_set():
                self.hub.publish_status("disconnected")
                await asyncio.sleep(2)

    async def _session(self, BleakClient, dev):
        disconnected = asyncio.Event()

        def on_disconnect(_c):
            disconnected.set()

        async with BleakClient(dev, timeout=20,
                               disconnected_callback=on_disconnect) as c:
            self.log("connected; subscribing to streams ...")
            await self._subscribe_all(c)
            # battery: read once up front (notify may not fire otherwise)
            await self._read_battery(c)
            self.hub.publish_status("connected",
                                    detail=getattr(dev, "name", "") or "")
            # hold the connection until it drops or we're told to stop
            while not disconnected.is_set() and not self._stop.is_set():
                if not c.is_connected:
                    break
                await asyncio.sleep(0.5)
            self.log("link closed")

    async def _subscribe_all(self, c):
        subs = [
            (HR_UUID, self._hr_cb, "HR/RR (0x2A37)"),
            (ECG_UUID, self._ecg_cb, "ECG (a1b20002)"),
            (ACCEL_UUID, self._accel_cb, "accel (a1b30002)"),
            (ECTOPY_UUID, self._ecto_cb, "ectopy (a1b40002)"),
            (BATTERY_UUID, self._batt_cb, "battery (0x2A19)"),
        ]
        for uuid, cb, label in subs:
            try:
                await c.start_notify(uuid, cb)
                self.log(f"  subscribed: {label}")
            except Exception as e:
                self.log(f"  skip {label}: {e}")

    async def _read_battery(self, c):
        try:
            val = await c.read_gatt_char(BATTERY_UUID)
            self.hub.publish_battery(parsers.parse_battery(val)["pct"])
        except Exception as e:
            self.log(f"  battery read skipped: {e}")

    # ---- notification callbacks (run in the loop thread) -----------------
    def _hr_cb(self, _sender, data):
        d = parsers.parse_hr(data)
        self.hub.publish_rr(d["hr"], d["rr"], d["contact"])

    def _ecg_cb(self, _sender, data):
        seq, samples = parsers.parse_ecg(data)
        self.hub.publish_ecg(seq, samples)

    def _accel_cb(self, _sender, data):
        d = parsers.parse_accel(data)
        self.hub.publish_accel(d["x"], d["y"], d["z"], d["steps"])

    def _ecto_cb(self, _sender, data):
        self.hub.publish_ectopy(parsers.parse_ectopy(data))

    def _batt_cb(self, _sender, data):
        self.hub.publish_battery(parsers.parse_battery(data)["pct"])
