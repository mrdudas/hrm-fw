"""Synthetic data source so the dashboard can be exercised without hardware.

Generates a plausible ECG waveform at 250 Hz, or 1024 Hz with --demo-fs 1024
(20-sample packets, every 80 / 19.5 ms),
HR/RR beats derived from the same rhythm, accelerometer, occasional ectopic
beats, and a slowly draining battery. Same publish_* API as BLESource.
"""
import asyncio
import math
import random
import time


class DemoSource:
    def __init__(self, hub, hr=62.0, log=print, fs=250, batch=20):
        self.hub = hub
        self.fs = fs                  # ECG sample rate to simulate (strap: 250 or 1024)
        self.batch = batch            # ECG samples per packet (strap: 20 or 40)
        self.notched_hz = 0           # demo stream carries no mains hum, so no strap notch
        self.base_hr = hr
        self.log = log
        self.enabled = True           # UI Disconnect pauses the synthetic stream
        self._stop = asyncio.Event()

    def stop(self):
        self._stop.set()

    def command(self, msg: dict):
        """Same UI commands as BLESource, simulated."""
        cmd = msg.get("cmd")
        if cmd == "disconnect":
            self.enabled = False
            self.hub.publish_status("idle", enabled=False, target=self._target())
        elif cmd == "connect":
            self.enabled = True
            self.hub.publish_status("demo", detail="synthetic stream", enabled=True,
                                    target=self._target())
        elif cmd == "scan":
            self.hub.publish_devices([
                {"address": "D7:CD:02:7A:05:33", "name": "HRM Raw RR", "rssi": -48, "strap": True},
                {"address": "D8:0F:B5:10:EA:56", "name": "Stratos 4 Pro", "rssi": -68, "strap": False},
                {"address": "56:9A:33:44:07:69", "name": "", "rssi": -56, "strap": False},
            ], scanning=False)

    @staticmethod
    def _target():
        return {"address": None, "name": "HRM Raw RR", "auto": True}

    async def run(self):
        self.log("DEMO mode: streaming synthetic data (no BLE)")
        self.hub.publish_status("demo", detail="synthetic stream", enabled=True,
                                target=self._target())
        self.hub.set_ecg_fs(self.fs, {"sample_hz": self.fs, "raw_batch": self.batch,
                                      "sample_bytes": 2, "fmt_ver": 1,
                                      "notched_hz": self.notched_hz})
        self.command({"cmd": "scan"})
        loop = asyncio.get_event_loop()
        await asyncio.gather(
            self._ecg_and_beats(loop),
            self._battery_loop(),
        )

    # ---- ECG + beat detection driving RR/ectopy --------------------------
    async def _ecg_and_beats(self, loop):
        fs = float(self.fs)
        seq = 0
        phase = 0.0                 # position within current RR interval (s)
        rr_s = 60.0 / self.base_hr  # current beat-to-beat interval (s)
        steps_since_beat = 0
        pvc = pac = art = total = 0
        packet = []
        last_r = None               # sample time of the previous R peak
        reported = True             # R of the current cycle already published?
        t_samp = 0.0
        next_t = time.monotonic()
        # accelerometer like the v2 firmware: one sample every acc_div ECG ticks,
        # batched 5 per packet with the ECG position (seq, offset) of the last one
        acc_div = max(1, round(fs / 25))
        acc_buf, tick = [], 0
        while not self._stop.is_set():
            packet.clear()
            for _ in range(self.batch):
                # QRS-ish morphology as a function of phase within the beat
                packet.append(int(self._ecg_sample(phase, rr_s)))
                phase += 1.0 / fs
                t_samp += 1.0 / fs
                tick += 1
                if tick % acc_div == 0:
                    acc_buf.append(self._accel_sample(t_samp))
                    if len(acc_buf) == 5:
                        if self.enabled:
                            self.hub.publish_accel_batch(acc_buf, self._steps,
                                                         ecg_seq=seq & 0xFFFF, ecg_off=len(packet) - 1)
                        acc_buf = []
                # like the firmware: report the beat shortly AFTER its R peak
                # (R sits at 0.32 of the cycle; ~60 ms detector latency)
                if not reported and phase >= 0.32 * rr_s + 0.06:
                    reported = True
                    r_t = t_samp - 0.06
                    if last_r is not None and self.enabled:
                        rr_ms = (r_t - last_r) * 1000.0
                        self.hub.publish_rr(round(60000.0 / rr_ms), [rr_ms], "yes")
                    last_r = r_t
                if phase >= rr_s:
                    phase -= rr_s
                    total += 1
                    reported = False
                    # decide the NEXT interval (respiratory sinus arrhythmia + noise)
                    hrv = 0.06 * math.sin(time.time() * 0.25) + random.gauss(0, 0.02)
                    rr_s = max(0.3, 60.0 / self.base_hr * (1 + hrv))
                    # ~4% chance of an ectopic beat
                    roll = random.random()
                    if roll < 0.025:
                        pvc += 1
                        rr_s = 0.34            # premature, short coupling
                        self._emit_ecto(1, 320, 900, pvc, pac, art, total)
                    elif roll < 0.04:
                        pac += 1
                        rr_s = 0.40
                        self._emit_ecto(2, 380, 500, pvc, pac, art, total)
            if self.enabled:
                self.hub.publish_ecg(seq & 0xFFFF, list(packet))
            seq += 1
            # pace on an absolute schedule so the simulated rate doesn't drift
            next_t += self.batch / fs
            await asyncio.sleep(max(0.0, next_t - time.monotonic()))

    def _ecg_sample(self, phase, rr_s):
        """A crude but recognizable P-QRS-T over the interval [0, rr_s)."""
        f = phase / rr_s
        v = 0.0
        v += 120 * math.exp(-((f - 0.12) ** 2) / (2 * 0.0016))     # P wave
        v += -80 * math.exp(-((f - 0.30) ** 2) / (2 * 0.00015))    # Q
        v += 900 * math.exp(-((f - 0.32) ** 2) / (2 * 0.00025))    # R
        v += -180 * math.exp(-((f - 0.35) ** 2) / (2 * 0.0004))    # S
        v += 260 * math.exp(-((f - 0.55) ** 2) / (2 * 0.006))      # T wave
        v += random.gauss(0, 18)                                   # noise
        return v

    def _emit_ecto(self, etype, coupling, pause, pvc, pac, art, total):
        if not self.enabled:
            return
        from config import ECTOPY_TYPES
        self.hub.publish_ectopy({
            "etype": etype, "type_name": ECTOPY_TYPES.get(etype, str(etype)),
            "flags": 0, "coupling_ms": coupling, "pause_ms": pause,
            "pvc": pvc, "pac": pac, "artifact": art, "total": total,
            "burden_pct": round(100.0 * (pvc + pac) / total, 2) if total else 0.0,
        })

    # ---- accelerometer ----------------------------------------------------
    _steps = 0

    def _accel_sample(self, t):
        """Gentle breathing motion on Z, noise on X/Y, an occasional step."""
        if random.random() < 0.006:
            self._steps += 1
        return (int(random.gauss(0, 300)), int(random.gauss(0, 300)),
                int(16000 + 800 * math.sin(t * 2 * math.pi * 0.25) + random.gauss(0, 200)))

    # ---- battery ----------------------------------------------------------
    async def _battery_loop(self):
        pct = 92
        while not self._stop.is_set():
            self.hub.publish_battery(pct)
            pct = max(1, pct - 1)
            await asyncio.sleep(15)
