"""Read back saved sessions for the review page (/review).

A session is the set of <stream>_<YYYYmmdd_HHMMSS>.csv files the recorder wrote.
The review page needs the beat series, so this turns rr_<session>.csv into
beat times + RR intervals and marks where beats were lost:

  The strap sends one 0x2A37 notification per beat (sometimes 2-3 RRs in one),
  stamped with the host's arrival time. Arrival jitters and comes in bursts, but
  only ever LATE, so (arrival - sum of RR so far) follows a floor that only steps
  up when beats are missing (a lost notification, a dropped link). The floor is
  the minimum over the following packets; a step of more than ~half a beat is a
  gap, and its size says how many beats are missing.

Results are cached per file (path, size, mtime), so the session being
recorded right now can be reviewed too -- it is re-read when it grew.
"""
import json
import os
import re

SESSION_RE = re.compile(r"^\d{8}_\d{6}$")
ACC_G = 16384          # LSB per g (SC7A20, +-2 g, left-justified int16)
ACT_BIN_S = 10         # activity: one value per 10 s
FLOOR_AHEAD = 40       # packets to look ahead for the arrival-time floor

_cache = {}


def _cached(path, fn):
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (path, st.st_size, st.st_mtime)
    hit = _cache.get((path, fn))
    if hit and hit[0] == key:
        return hit[1]
    val = fn(path)
    _cache[(path, fn)] = (key, val)
    return val


def _rows(path):
    """Data rows of a CSV as lists of strings (header skipped, torn last line dropped)."""
    with open(path, newline="") as f:
        next(f, None)
        for line in f:
            if line.endswith("\n"):
                yield line.rstrip("\r\n").split(",")


def list_sessions(outdir):
    out = []
    try:
        names = os.listdir(outdir)
    except OSError:
        return out
    for name in names:
        if not (name.startswith("rr_") and name.endswith(".csv")):
            continue
        ses = name[3:-4]
        if not SESSION_RE.match(ses):
            continue
        info = _cached(os.path.join(outdir, name), _rr_summary)
        if info and info["beats"] > 0:
            out.append({"id": ses, **info})
    out.sort(key=lambda d: d["id"], reverse=True)
    return out


def _rr_summary(path):
    first = last = None
    n = 0
    for r in _rows(path):
        try:
            t = float(r[0])
        except (ValueError, IndexError):
            continue
        if first is None:
            first = t
        last = t
        n += 1
    return {"start": first, "end": last, "beats": n} if n else {"beats": 0}


def load_session(outdir, ses):
    if not SESSION_RE.match(ses):
        raise ValueError("bad session id")
    rr_path = os.path.join(outdir, f"rr_{ses}.csv")
    if not os.path.exists(rr_path):
        raise FileNotFoundError(ses)
    beats = _cached(rr_path, _beats)
    ecto = _cached(os.path.join(outdir, f"ectopy_{ses}.csv"), _ectopy) or []
    act = _cached(os.path.join(outdir, f"accel_{ses}.csv"), _activity) or {"t": [], "v": []}
    meta = {}
    try:
        with open(os.path.join(outdir, f"meta_{ses}.json")) as f:
            meta = json.load(f)
    except (OSError, ValueError):
        pass
    return {"id": ses, "beats": beats, "ectopy": ecto, "activity": act,
            "meta": {k: meta[k] for k in ("ecg_fs", "ecg_info", "hp_cfg") if k in meta}}


def _beats(path):
    packets = []                       # (arrival, [rr ms ...])
    for r in _rows(path):
        try:
            t, rr = float(r[0]), float(r[2])
        except (ValueError, IndexError):
            continue
        if packets and packets[-1][0] == t:
            packets[-1][1].append(rr)
        else:
            packets.append((t, [rr]))
    if not packets:
        return {"t": [], "rr": [], "gap": []}
    # offset of each packet: arrival minus the RR sum up to and including it
    off, cum = [], 0.0
    for t, rrs in packets:
        cum += sum(rrs) / 1000
        off.append(t - cum)
    # floor: min over the packets that follow (late arrivals only raise it)
    floor = [0.0] * len(off)
    win = []
    for i in range(len(off) - 1, -1, -1):
        win.append(off[i])
        if len(win) > FLOOR_AHEAD:
            win.pop(0)
        floor[i] = min(win)
    # A step in the floor between neighbouring packets is a gap (the slow
    # drift between the strap's and the host's clocks never makes one). Beat
    # time = floor + RR sum: smooth on the strap's clock, jumping at gaps.
    ts, rr_out, gaps = [], [], []
    cum = 0.0
    for i, (t, rrs) in enumerate(packets):
        missing = 0
        if i:
            step = floor[i] - floor[i - 1]
            if step > 0.6 * rrs[0] / 1000:
                missing = max(1, round(step / (rrs[0] / 1000)))
        for k, rr in enumerate(rrs):
            cum += rr / 1000
            ts.append(round(floor[i] + cum, 3))
            rr_out.append(rr)
            gaps.append(missing if k == 0 else 0)
    return {"t": ts, "rr": rr_out, "gap": gaps}


def _ectopy(path):
    out = []
    for r in _rows(path):
        try:
            out.append([float(r[0]), r[1], int(r[2] or 0), int(r[3] or 0)])
        except (ValueError, IndexError):
            continue
    return out


def _activity(path):
    """Movement per ACT_BIN_S: standard deviation of |a| in g (0 = still)."""
    out_t, out_v = [], []
    cur, n, s, ss = None, 0, 0.0, 0.0
    for r in _rows(path):
        try:
            t = float(r[0])
            x, y, z = int(r[1]), int(r[2]), int(r[3])
        except (ValueError, IndexError):
            continue
        b = int(t // ACT_BIN_S)
        if b != cur:
            if n > 5:
                mean = s / n
                out_t.append(cur * ACT_BIN_S + ACT_BIN_S / 2)
                out_v.append(round(max(0.0, ss / n - mean * mean) ** 0.5, 4))
            cur, n, s, ss = b, 0, 0.0, 0.0
        a = (x * x + y * y + z * z) ** 0.5 / ACC_G
        n += 1
        s += a
        ss += a * a
    return {"t": out_t, "v": out_v}
