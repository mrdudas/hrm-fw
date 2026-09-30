"""CSV recorder: one timestamped file per stream, flushed regularly.

Files land in <recordings>/<stream>_<sessionstart>.csv. Writes are flushed after
every event so a crash loses at most the last packet.
"""
import csv
import os
import time


class CSVRecorder:
    HEADERS = {
        "ecg":     ["unix_time", "sample_index", "adc"],
        "rr":      ["unix_time", "hr_bpm", "rr_ms"],
        "accel":   ["unix_time", "x", "y", "z", "steps"],
        "ectopy":  ["unix_time", "type", "coupling_ms", "pause_ms",
                    "pvc", "pac", "artifact", "total", "burden_pct"],
        "battery": ["unix_time", "pct"],
    }

    def __init__(self, outdir: str, session: str | None = None):
        self.outdir = outdir
        os.makedirs(outdir, exist_ok=True)
        self.session = session or time.strftime("%Y%m%d_%H%M%S")
        self._files = {}
        self._writers = {}
        for stream, header in self.HEADERS.items():
            path = os.path.join(outdir, f"{stream}_{self.session}.csv")
            f = open(path, "w", newline="")
            w = csv.writer(f)
            w.writerow(header)
            f.flush()
            self._files[stream] = f
            self._writers[stream] = w

    def paths(self):
        return {s: os.path.join(self.outdir, f"{s}_{self.session}.csv")
                for s in self.HEADERS}

    def write_ecg(self, t0_wall, base_index, samples):
        """One row per sample; time reconstructed from the packet's base index."""
        w = self._writers["ecg"]
        for k, adc in enumerate(samples):
            idx = base_index + k
            w.writerow([f"{t0_wall + idx / 250.0:.4f}", idx, adc])
        self._files["ecg"].flush()

    def write_rr(self, t, hr, rr_list):
        w = self._writers["rr"]
        if rr_list:
            for rr in rr_list:
                w.writerow([f"{t:.4f}", hr, round(rr)])
        else:
            w.writerow([f"{t:.4f}", hr, ""])
        self._files["rr"].flush()

    def write_accel(self, t, x, y, z, steps):
        self._writers["accel"].writerow([f"{t:.4f}", x, y, z, steps])
        self._files["accel"].flush()

    def write_ectopy(self, t, d):
        self._writers["ectopy"].writerow([
            f"{t:.4f}", d["type_name"], d["coupling_ms"], d["pause_ms"],
            d["pvc"], d["pac"], d["artifact"], d["total"], d["burden_pct"],
        ])
        self._files["ectopy"].flush()

    def write_battery(self, t, pct):
        self._writers["battery"].writerow([f"{t:.4f}", pct])
        self._files["battery"].flush()

    def close(self):
        for f in self._files.values():
            try:
                f.flush()
                f.close()
            except Exception:
                pass
