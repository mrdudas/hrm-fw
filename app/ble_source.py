"""BLE data source: a small state machine driven by the web UI.

States (published to the dashboard as status messages):
  idle        user pressed Disconnect: no scanning, no connection
  scanning    looking for the target (name match, or the address picked in the UI)
  waiting     target not found; the next scan starts after RETRY_S
  connecting  / connected / disconnected

The UI sends commands over the WebSocket (see `command()`): pick a device from
the scan list or go back to name-based auto discovery, disconnect, or scan now.
Every scan publishes the list of nearby devices so the UI can offer them in a
dropdown. The chosen device is remembered in device.json across restarts.

`bleak` is imported lazily so demo mode and the web UI work without it installed.
"""
import asyncio
import json
import os
import time

from config import (DEVICE_NAME, KNOWN_ADDRESS, HR_UUID, ECG_UUID, ACCEL_UUID,
                    ECTOPY_UUID, BATTERY_UUID, ECG_INFO_UUID, ECG_FS,
                    LINK_UUID)
import parsers

SCAN_S = 8          # length of one scan
RETRY_S = 60        # pause between scans while the strap is not found
RECONNECT_S = 2     # quick retry right after a dropped link
SETTINGS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "device.json")


async def scan_devices(timeout=6):
    """Return list of (address, name, rssi) for all advertising devices."""
    from bleak import BleakScanner
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    out = []
    for addr, (dev, adv) in found.items():
        out.append((addr, adv.local_name or dev.name or "?", adv.rssi))
    out.sort(key=lambda x: -(x[2] if x[2] is not None else -999))
    return out


def load_target():
    try:
        with open(SETTINGS) as f:
            d = json.load(f)
        return d.get("address") or None, d.get("name") or ""
    except (OSError, ValueError):
        return None, ""


def save_target(address, name):
    try:
        if address:
            with open(SETTINGS, "w") as f:
                json.dump({"address": address, "name": name}, f)
        elif os.path.exists(SETTINGS):
            os.remove(SETTINGS)
    except OSError:
        pass


class BLESource:
    def __init__(self, hub, name=DEVICE_NAME, address=None, log=print):
        self.hub = hub
        self.name = name                 # auto mode: match this advertised name
        if address:                      # CLI wins over the remembered choice
            self.address, self.address_name = address, ""
        else:
            self.address, self.address_name = load_target()
        self.log = log
        self.enabled = True              # False = user pressed Disconnect
        self._stop = asyncio.Event()
        self._wake = asyncio.Event()     # a command arrived: re-evaluate now
        self._scan_requested = False
        self._seen = {}                  # address -> (name, rssi) from the last scan
        # raw ECG: with several hosts the strap streams raw ECG to one (last
        # subscriber wins); the others keep HR/RR/ectopy/accel
        self._ecg_sub = False
        self._take_raw = False
        self._raw_kick = asyncio.Event()
        self._ecg_last = 0.0             # monotonic time of the last ECG packet
        self._vdd = None                 # [min, max] mV over all reads since the last log

    def stop(self):
        self._stop.set()
        self._wake.set()

    # ---- commands from the web UI ------------------------------------------
    def command(self, msg: dict):
        cmd = msg.get("cmd")
        if cmd == "connect":
            addr = (msg.get("address") or "").strip() or None
            self.address = addr
            self.address_name = (msg.get("name") or "") if addr else ""
            save_target(self.address, self.address_name)
            self.enabled = True
            self.log(f"UI: connect to {addr or repr(self.name) + ' (auto)'}")
        elif cmd == "disconnect":
            self.enabled = False
            self.log("UI: disconnect")
        elif cmd == "scan":
            self._scan_requested = True
        elif cmd == "take_raw":          # subscribe to raw ECG even if another host has it
            self._take_raw = True
            self._raw_kick.set()
            self.log("UI: take over raw ECG")
            return
        else:
            return
        self._wake.set()

    def _target(self):
        return {"address": self.address, "name": self.address_name if self.address else self.name,
                "auto": self.address is None}

    def _status(self, state, detail="", **extra):
        self.hub.publish_status(state, detail=detail, target=self._target(),
                                enabled=self.enabled, **extra)

    async def _sleep(self, seconds):
        """Sleep, but return early (True) when a command arrives."""
        self._wake.clear()
        try:
            await asyncio.wait_for(self._wake.wait(), seconds)
            return True
        except asyncio.TimeoutError:
            return False

    # ---- scanning -------------------------------------------------------------
    def _matches(self, addr, name):
        if self.address:
            return addr.upper() == self.address.upper()
        return name == self.name or addr.upper() == KNOWN_ADDRESS.upper()

    async def _scan(self, want_target):
        """Scan up to SCAN_S, publishing the device list as it fills in.

        Returns the target BLEDevice as soon as it is seen (if want_target), else
        None. Also returns early when a command changes what we should do.
        """
        from bleak import BleakScanner
        seen, hit = {}, {}
        found = asyncio.Event()

        def on_adv(dev, adv):
            nm = adv.local_name or dev.name or ""
            seen[dev.address] = (nm or seen.get(dev.address, ("",))[0], adv.rssi)
            if want_target and self._matches(dev.address, nm):
                hit["dev"] = dev
                found.set()

        self._wake.clear()
        t_end = time.monotonic() + SCAN_S
        async with BleakScanner(detection_callback=on_adv):
            while time.monotonic() < t_end and not found.is_set() and not self._wake.is_set():
                try:
                    await asyncio.wait_for(found.wait(), min(1.0, t_end - time.monotonic()))
                except asyncio.TimeoutError:
                    pass
                self._publish_devices(seen, scanning=True)
        self._seen = seen
        self._publish_devices(seen, scanning=False)
        return hit.get("dev")

    def _publish_devices(self, seen, scanning):
        devs = [{"address": a, "name": n, "rssi": r,
                 "strap": n == self.name or a.upper() == KNOWN_ADDRESS.upper()}
                for a, (n, r) in seen.items()]
        devs.sort(key=lambda d: (not d["strap"], not d["name"], -(d["rssi"] or -999)))
        self.hub.publish_devices(devs, scanning)

    # ---- main loop --------------------------------------------------------------
    async def run(self):
        from bleak import BleakClient
        while not self._stop.is_set():
            if not self.enabled:
                self._status("idle")
                if self._scan_requested:          # list nearby devices, don't connect
                    self._scan_requested = False
                    await self._safe_scan(want_target=False)
                    continue
                await self._sleep(None)
                continue

            self._scan_requested = False
            self._status("scanning")
            dev = await self._safe_scan(want_target=True)
            if not self.enabled or self._stop.is_set():
                continue
            if dev is None:
                if self._wake.is_set():           # command arrived mid-scan
                    continue
                nxt = time.time() + RETRY_S
                self.log(f"strap not found; next scan in {RETRY_S}s")
                self._status("waiting", next_scan=nxt)
                await self._sleep(RETRY_S)
                continue

            self.log(f"connecting to {dev.address} ({dev.name or ''}) ...")
            self._status("connecting", detail=dev.name or dev.address)
            try:
                await self._session(BleakClient, dev)
            except Exception as e:
                self.log(f"BLE session error: {e!r}")
            if self.enabled and not self._stop.is_set():
                self._status("disconnected")
                await self._sleep(RECONNECT_S)
        self._status("idle")

    async def _safe_scan(self, want_target):
        try:
            return await self._scan(want_target)
        except Exception as e:
            self.log(f"scan failed: {e!r}")
            self._status("error", detail=f"scan failed: {e}")
            await self._sleep(5)
            return None

    async def _session(self, BleakClient, dev):
        disconnected = asyncio.Event()
        target = self._target()

        def on_disconnect(_c):
            disconnected.set()

        async with BleakClient(dev, timeout=20,
                               disconnected_callback=on_disconnect) as c:
            self.log("connected; subscribing to streams ...")
            await self._read_ecg_info(c)       # before subscribing: rate needed for the first packet
            await self._subscribe_all(c)       # everything except raw ECG
            self._ecg_sub = False
            await self._raw_decide(c, await self._read_link(c))
            # battery: read once up front (notify may not fire otherwise)
            await self._read_battery(c)
            label = dev.name or dev.address
            self._status("connected", detail=label, address=dev.address)
            link_task = asyncio.create_task(self._link_params(c))
            # hold the link until it drops, the user disconnects or picks another device
            while (not disconnected.is_set() and not self._stop.is_set()
                   and self.enabled and self._target() == target and c.is_connected):
                # raw ECG went quiet while subscribed: another host may have taken
                # it over -> check ownership now instead of at the next poll
                if self._ecg_sub and time.monotonic() - self._ecg_last > 2 and not self._raw_kick.is_set():
                    self._ecg_last = time.monotonic()
                    self._raw_kick.set()
                if self._scan_requested:          # refresh the list while connected
                    self._scan_requested = False
                    await self._safe_scan(want_target=False)
                    self._status("connected", detail=label, address=dev.address)
                    continue
                await self._sleep(0.5)
            link_task.cancel()
            self.hub.publish_raw("none")
            self.log("link closed")

    async def _read_link(self, c, log=False):
        """One a1b20004 reading (None on firmware without it)."""
        try:
            link = parsers.parse_link(await c.read_gatt_char(LINK_UUID))
        except asyncio.CancelledError:
            raise
        except Exception:
            return None
        link["host_mtu"] = getattr(c, "mtu_size", None)   # bleak's view, cross-check
        link["t"] = time.time()
        # every read resets the strap's VDD window, and we read more often than we
        # log (3 s polling, watchdog): fold all reads into the logged extremes
        if "vdd_min_mv" in link:
            v = self._vdd
            self._vdd = ([min(v[0], link["vdd_min_mv"]), max(v[1], link["vdd_max_mv"])] if v
                         else [link["vdd_min_mv"], link["vdd_max_mv"]])
        if log and self._vdd:
            link["vdd_min_mv"], link["vdd_max_mv"] = self._vdd
            self._vdd = None
        if log:
            self.log(f"  link: interval {link['interval_ms']:g} ms, latency {link['latency']}, "
                     f"timeout {link['timeout_ms']} ms, ATT MTU {link['mtu']} (host says {link['host_mtu']})"
                     + (f", {link['conn_count']} host(s) connected" if "conn_count" in link else "")
                     + (f", raw ECG owner: {link['raw_owner']}" if "raw_owner" in link else "")
                     + (f", VDD {link['vdd_min_mv']}-{link['vdd_max_mv']} mV" if "vdd_min_mv" in link else ""))
            self.hub.publish_link(link)
        return link

    async def _link_params(self, c):
        """Read the strap's view of the link (a1b20004): 5 s after connecting (once
        the peripheral's conn-param update has settled), then every minute -- every
        3 s while we don't have the raw ECG stream, so we claim it as soon as it frees
        up. Silently stops on firmware without the characteristic."""
        await asyncio.sleep(5)
        last_log = 0.0
        while True:
            link = await self._read_link(c, log=time.time() - last_log >= 55)
            if link is None:
                self.log("  link params not available")
                return
            if time.time() - last_log >= 55:
                last_log = time.time()
            await self._raw_decide(c, link)
            self._raw_kick.clear()
            try:
                await asyncio.wait_for(self._raw_kick.wait(), 60 if self._ecg_sub else 3)
            except asyncio.TimeoutError:
                pass

    async def _raw_decide(self, c, link):
        """Subscribe to / release raw ECG according to the strap's ownership byte."""
        owner = (link or {}).get("raw_owner")
        if owner is None:                      # older firmware: every host gets raw ECG
            if not self._ecg_sub:
                await self._ecg_notify(c, True)
            self.hub.publish_raw("legacy")
            return
        if self._take_raw or (owner == "none" and not self._ecg_sub):
            self._take_raw = False
            await self._ecg_notify(c, True)    # last subscriber wins -> ours now
        elif owner == "other" and self._ecg_sub:
            self.log("  raw ECG taken over by another host")
            await self._ecg_notify(c, False)   # release, so we can reclaim when it frees
        self.hub.publish_raw("mine" if self._ecg_sub else "other")

    async def _ecg_notify(self, c, on):
        try:
            if on:
                self._ecg_last = time.monotonic()
                await c.start_notify(ECG_UUID, self._ecg_cb)
                self.log("  subscribed: ECG (a1b20002)")
            else:
                await c.stop_notify(ECG_UUID)
                self.log("  unsubscribed: ECG (a1b20002)")
            self._ecg_sub = on
        except Exception as e:
            self.log(f"  ECG {'subscribe' if on else 'unsubscribe'} failed: {e}")

    async def _subscribe_all(self, c):
        subs = [
            (HR_UUID, self._hr_cb, "HR/RR (0x2A37)"),
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

    async def _read_ecg_info(self, c):
        """ECG sample rate etc. from a1b20003; older firmware lacks it -> 250 Hz."""
        try:
            info = parsers.parse_ecg_info(await c.read_gatt_char(ECG_INFO_UUID))
            fs = info["sample_hz"] or ECG_FS
            self.log(f"  ECG info: {info}")
        except Exception as e:
            info, fs = None, ECG_FS
            self.log(f"  ECG info char not available ({e.__class__.__name__}); assuming {ECG_FS} Hz")
        self.hub.set_ecg_fs(fs, info)

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
        self._ecg_last = time.monotonic()
        seq, samples = parsers.parse_ecg(data)
        self.hub.publish_ecg(seq, samples)

    def _accel_cb(self, _sender, data):
        d = parsers.parse_accel(data)
        self.hub.publish_accel_batch(d["samples"], d["steps"], d.get("ecg_seq"), d.get("ecg_off"))

    def _ecto_cb(self, _sender, data):
        self.hub.publish_ectopy(parsers.parse_ectopy(data))

    def _batt_cb(self, _sender, data):
        self.hub.publish_battery(parsers.parse_battery(data)["pct"])
