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
        for key in ("devices", "battery", "rr", "accel", "ectopy"):
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

    def publish_ecg(self, seq: int, samples: list):
        t = time.time()
        if self._ecg_seq0 is None:
            self._ecg_seq0 = seq
            self._ecg_t0 = t
        base = ((seq - self._ecg_seq0) & 0xFFFF) * len(samples)
        self.recorder.write_ecg(self._ecg_t0, base, samples)
        self._emit({"type": "ecg", "t": t, "seq": seq,
                    "base": base, "samples": samples})

    def publish_rr(self, hr, rr_list, contact="n/a"):
        t = time.time()
        self.recorder.write_rr(t, hr, rr_list)
        self._emit({"type": "rr", "t": t, "hr": hr,
                    "rr": [round(x, 1) for x in rr_list], "contact": contact},
                   snapshot_key="rr")

    def publish_accel(self, x, y, z, steps, age=0.0):
        """`age`: seconds since the sample was taken (batched packets carry several)."""
        t = time.time() - age
        self.recorder.write_accel(t, x, y, z, steps)
        self._emit({"type": "accel", "t": t, "x": x, "y": y, "z": z,
                    "steps": steps}, snapshot_key="accel")

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
