"""Central hub: fan events out to CSV + all WebSocket clients.

A single data source (BLE or demo) calls the typed publish_* methods from the
asyncio loop thread. The hub records to CSV synchronously and queues a JSON
string for the async broadcaster task, which sends to every connected client.
It also keeps the latest message per stream so a freshly (re)loaded page gets an
immediate snapshot instead of a blank dashboard.
"""
import asyncio
import json
import time


class Hub:
    def __init__(self, recorder):
        self.recorder = recorder
        self.clients = set()          # set of web.WebSocketResponse
        self._queue = asyncio.Queue()
        self._snapshot = {}           # type -> last event dict (json-ready)
        self._status = {"type": "status", "state": "starting"}
        self.source = None            # data source; receives UI commands
        # ECG time anchor for reconstructing a continuous sample index/time axis
        self._ecg_seq0 = None
        self._ecg_t0 = None
        self.ecg_fs = 250             # set per connection from the a1b20003 info char
        self._ecg_last_seq = None
        self.ecg_duplicates = 0       # packets dropped as exact seq repeats
        self._ecg_batch = 20          # samples per ECG packet (a1b20003 raw_batch)
        self._acc_div = 10            # ECG ticks per accel sample (a1b20003 acc_div)

    # ---- broadcaster ------------------------------------------------------
    async def broadcaster(self):
        while True:
            msg = await self._queue.get()
            if not self.clients:
                continue
            dead = []
            for ws in self.clients:
                try:
                    await ws.send_str(msg)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self.clients.discard(ws)

    def _emit(self, event: dict, snapshot_key: str | None = None):
        s = json.dumps(event)
        if snapshot_key:
            self._snapshot[snapshot_key] = s
        try:
            self._queue.put_nowait(s)
        except Exception:
            pass

    # ---- client lifecycle -------------------------------------------------
    def add_client(self, ws):
        self.clients.add(ws)

    def remove_client(self, ws):
        self.clients.discard(ws)

    def snapshot_messages(self):
        """JSON strings to send a newly connected client (status + last of each)."""
        out = [json.dumps(self._status)]
        for key in ("ecg_info", "devices", "battery", "rr", "accel", "ectopy", "link", "raw"):
            if key in self._snapshot:
                out.append(self._snapshot[key])
        return out

    def command(self, msg: dict):
        """Client -> server control message (connect / disconnect / scan)."""
        if self.source is not None and hasattr(self.source, "command"):
            self.source.command(msg)

    # ---- typed publishers (called by the data source) --------------------
    def publish_status(self, state: str, detail: str = "", **extra):
        self._status = {"type": "status", "state": state, "detail": detail,
                        "t": time.time(), **extra}
        self._emit(self._status)

    def publish_devices(self, devices: list, scanning: bool):
        self._emit({"type": "devices", "devices": devices, "scanning": scanning,
                    "t": time.time()}, snapshot_key="devices")

    def publish_raw(self, state: str):
        """Raw-ECG ownership on a multi-host strap: mine / other / legacy."""
        self._emit({"type": "raw", "state": state, "t": time.time()}, snapshot_key="raw")

    def publish_link(self, link: dict):
        """Connection parameters as reported by the strap (a1b20004)."""
        self.recorder.add_link(link)
        self._emit({"type": "link", **link}, snapshot_key="link")

    def set_ecg_fs(self, fs: int, info: dict | None = None):
        """ECG sample rate of the connected strap. A change restarts the ECG time base."""
        if fs != self.ecg_fs:
            self._ecg_seq0 = None
        info = info or {}
        self._ecg_batch = info.get("raw_batch") or self._ecg_batch
        self._acc_div = info.get("acc_div") or max(1, round(fs / 25))
        self._ecg_last_seq = None     # new connection: a seq repeat across it is not a duplicate
        self.ecg_fs = fs
        self.recorder.set_ecg_fs(fs, info)
        # tell the dashboard whether the strap already notches mains hum
        self._emit({"type": "ecg_info", "fs": fs, "notched_hz": info.get("notched_hz", 0)},
                   snapshot_key="ecg_info")

    def publish_ecg(self, seq: int, samples: list):
        # The strap can deliver the same packet twice (TX retry after -ENOMEM
        # re-notifies every connection, so with two hosts one gets a repeat).
        # Drop exact repeats before they reach the CSV or the dashboard.
        if seq == self._ecg_last_seq:
            self.ecg_duplicates += 1
            return
        self._ecg_last_seq = seq
        self._ecg_batch = len(samples) or self._ecg_batch
        t = time.time()
        if self._ecg_seq0 is None:
            self._ecg_seq0 = seq
            self._ecg_t0 = t
        base = ((seq - self._ecg_seq0) & 0xFFFF) * len(samples)
        self.recorder.write_ecg(self._ecg_t0, base, samples, rx_time=t)
        self._emit({"type": "ecg", "t": t, "seq": seq, "fs": self.ecg_fs,
                    "base": base, "samples": samples})

    def publish_rr(self, hr, rr_list, contact="n/a"):
        t = time.time()
        self.recorder.write_rr(t, hr, rr_list)
        self._emit({"type": "rr", "t": t, "hr": hr,
                    "rr": [round(x, 1) for x in rr_list], "contact": contact},
                   snapshot_key="rr")

    def publish_accel_batch(self, samples, steps, ecg_seq=None, ecg_off=None):
        """Accel samples (oldest first, one every acc_div ECG ticks). With v2 packets
        (ecg_seq/ecg_off of the last sample) each sample also gets its ECG sample
        index in this hub's ECG index space, so it lands on the ECG timebase."""
        n, now = len(samples), time.time()
        last_idx = None
        if ecg_seq is not None and self._ecg_seq0 is not None:
            last_idx = ((ecg_seq - self._ecg_seq0) & 0xFFFF) * self._ecg_batch + ecg_off
        for k, (x, y, z) in enumerate(samples):
            back = (n - 1 - k) * self._acc_div          # ECG ticks before the last sample
            idx = last_idx - back if last_idx is not None else None
            self.publish_accel(x, y, z, steps, age=back / self.ecg_fs, ecg_index=idx, t_now=now)

    def publish_accel(self, x, y, z, steps, age=0.0, ecg_index=None, t_now=None):
        """`age`: seconds since the sample was taken (batched packets carry several).
        `ecg_index`: the sample's position in the ECG stream, if the strap reports it."""
        t = (t_now or time.time()) - age
        self.recorder.write_accel(t, x, y, z, steps, ecg_index)
        msg = {"type": "accel", "t": t, "x": x, "y": y, "z": z, "steps": steps}
        if ecg_index is not None:
            msg["ecg_index"] = ecg_index
        self._emit(msg, snapshot_key="accel")

    def publish_ectopy(self, d: dict):
        t = time.time()
        self.recorder.write_ectopy(t, d)
        event = {"type": "ectopy", "t": t, **d}
        self._emit(event, snapshot_key="ectopy")

    def publish_battery(self, pct):
        t = time.time()
        self.recorder.write_battery(t, pct)
        self._emit({"type": "battery", "t": t, "pct": pct},
                   snapshot_key="battery")
