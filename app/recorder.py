"""CSV recorder: one timestamped file per stream, flushed regularly.

Files land in <recordings>/<stream>_<sessionstart>.csv. Writes are flushed after
every event so a crash loses at most the last packet.
"""
import csv
import json
import os
import time


class CSVRecorder:
    HEADERS = {
        "ecg":     ["unix_time", "sample_index", "adc", "rx_time"],
        "rr":      ["unix_time", "hr_bpm", "rr_ms"],
        "accel":   ["unix_time", "x", "y", "z", "steps", "ecg_index"],
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

        self.ecg_fs = 250
        self._meta = {}
        self.set_ecg_fs(250)

    def set_ecg_fs(self, fs, info=None):
        """ECG sample rate for the CSV time column; also saved to meta_<session>.json
        so offline tools (tools/analyze_recording.py) know the rate."""
        self.ecg_fs = fs
        self._meta.update({"ecg_fs": fs, "ecg_info": info or {}})
        self._write_meta()

    def add_link(self, link):
        """Append a link-parameter reading (a1b20004) to meta_<session>.json."""
        self._meta.setdefault("link", []).append(link)
        self._write_meta()

    def _write_meta(self):
        try:
            with open(os.path.join(self.outdir, f"meta_{self.session}.json"), "w") as f:
                json.dump(self._meta, f)
        except OSError:
            pass

    def paths(self):
        return {s: os.path.join(self.outdir, f"{s}_{self.session}.csv")
                for s in self.HEADERS}

    def write_ecg(self, t0_wall, base_index, samples, rx_time=None):
        """One row per sample; time reconstructed from the packet's base index.
        rx_time: host arrival time of the packet (same on all its rows), so
        offline tools can measure the real sample rate over wall-clock time."""
        w = self._writers["ecg"]
        rx = f"{rx_time:.4f}" if rx_time is not None else ""
        for k, adc in enumerate(samples):
            idx = base_index + k
            w.writerow([f"{t0_wall + idx / self.ecg_fs:.5f}", idx, adc, rx])
        self._files["ecg"].flush()

    def write_rr(self, t, hr, rr_list):
        w = self._writers["rr"]
        if rr_list:
            for rr in rr_list:
                w.writerow([f"{t:.4f}", hr, round(rr)])
        else:
            w.writerow([f"{t:.4f}", hr, ""])
        self._files["rr"].flush()

    def write_accel(self, t, x, y, z, steps, ecg_index=None):
        """ecg_index: the sample's index in ecg_<session>.csv's sample_index space
        (accel v2 firmware), else empty."""
        self._writers["accel"].writerow([f"{t:.4f}", x, y, z, steps,
                                         "" if ecg_index is None else ecg_index])
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
