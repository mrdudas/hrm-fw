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
import math
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


# ---------- resting windows (daily summary page, /daily) ----------
#
# HRV from a random stretch of a recording says little: movement, posture and
# talking change it more than recovery or stress do. The daily summary uses
# only REST_WIN_S windows in which the accelerometer shows the strap lying
# still -- for the whole window and SETTLE_S before it -- with no lost beats
# and few corrected ones. Each window gives HR, RMSSD (lnRMSSD), SDNN and the
# deceleration capacity; the page groups them into days.

REST_WIN_S = 300          # window length (the usual short-term HRV recording)
REST_STEP_S = 30          # a failed window: try again this much later
SETTLE_S = 60             # still for this long before the window, too
REST_G = 0.015            # activity (SD of |a| per 10 s, g) at or below = still
REST_MAX_BAD = 0.05       # at most this share of corrected beats
RR_MIN, RR_MAX = 250, 2500
DEV_MAX = 0.2
STALE_RUN = 5

_rest_cache = {}


def clean(rr, gap):
    """Artifact / ectopic beats replaced by the local median of good beats --
    the same rules as HRV.clean in static/hrv.js. Returns (rrc, bad)."""
    n = len(rr)
    bad = [not (RR_MIN <= v <= RR_MAX) for v in rr]
    i = 0
    while i < n:                                  # stale repeats (old firmware)
        j = i + 1
        while j < n and rr[j] == rr[i]:
            j += 1
        if j - i >= STALE_RUN:
            for k in range(i, j):
                bad[k] = True
        i = j
    W, SEARCH = 5, 40
    med, dev = [0.0] * n, [False] * n
    for i in range(n):
        buf, c = [], 0
        for j in range(i - 1, max(0, i - SEARCH) - 1, -1):
            if not bad[j]:
                buf.append(rr[j]); c += 1
                if c == W:
                    break
        c = 0
        for j in range(i + 1, min(n - 1, i + SEARCH) + 1):
            if not bad[j]:
                buf.append(rr[j]); c += 1
                if c == W:
                    break
        if buf:
            buf.sort()
            m = buf[len(buf) >> 1]
            med[i] = m
            if not bad[i] and abs(rr[i] - m) > DEV_MAX * m:
                dev[i] = True
        else:
            med[i] = min(RR_MAX, max(RR_MIN, rr[i]))
    bad = [b or d for b, d in zip(bad, dev)]
    return [med[i] if bad[i] else rr[i] for i in range(n)], bad


def deceleration_capacity(rrc, bad, a, b):
    """Deceleration capacity (Bauer et al. 2006, phase-rectified signal
    averaging): anchor on every beat that is longer than the one before (by
    under 5 %, larger jumps are artifacts), average the RR around the anchors,
    DC = (X0 + X1 - X-1 - X-2) / 4 in ms. It measures how strongly the heart
    slows from beat to beat -- vagal modulation -- and is robust to artifacts
    and slow trends. Returns (dc, number of anchors)."""
    s = [0.0, 0.0, 0.0, 0.0]               # sums of X(-2), X(-1), X(0), X(1)
    n = 0
    for i in range(a + 2, b - 1):
        if not (rrc[i - 1] < rrc[i] < 1.05 * rrc[i - 1]):
            continue
        if bad[i - 2] or bad[i - 1] or bad[i] or bad[i + 1]:
            continue
        for k in range(4):
            s[k] += rrc[i - 2 + k]
        n += 1
    if n < 20:
        return None, n
    return (s[2] + s[3] - s[1] - s[0]) / (4 * n), n


def _session_rest(outdir, ses):
    rr_path = os.path.join(outdir, f"rr_{ses}.csv")
    acc_path = os.path.join(outdir, f"accel_{ses}.csv")
    beats = _cached(rr_path, _beats)
    act = _cached(acc_path, _activity) or {"t": [], "v": []}
    t, rr, gap = beats["t"], beats["rr"], beats["gap"]
    n = len(t)
    out = []
    if n < 100:
        return out
    rrc, bad = clean(rr, gap)
    have_acc = len(act["t"]) > 0
    at, av = act["t"], act["v"]
    import bisect
    nbins_need = 0.8 * (REST_WIN_S + SETTLE_S) / ACT_BIN_S

    def still(t0, t1):
        lo, hi = bisect.bisect_left(at, t0), bisect.bisect_left(at, t1)
        if hi - lo < nbins_need:
            return None                         # no accelerometer data there
        return max(av[lo:hi]) <= REST_G

    t0 = t[0]
    while t0 + REST_WIN_S <= t[-1]:
        a = bisect.bisect_left(t, t0)
        b = bisect.bisect_left(t, t0 + REST_WIN_S)
        st = still(t0 - SETTLE_S, t0 + REST_WIN_S) if have_acc else None
        ok = (st is not False and b - a >= REST_WIN_S * 0.3
              and not any(gap[a + 1:b])
              and t[b - 1] - t[a] >= 0.9 * REST_WIN_S)
        nb = sum(bad[a:b]) if ok else 0
        if ok and nb <= REST_MAX_BAD * (b - a):
            N = b - a
            mean = sum(rrc[a:b]) / N
            sdnn = (sum((v - mean) ** 2 for v in rrc[a:b]) / (N - 1)) ** 0.5
            d2 = sum((rrc[i] - rrc[i - 1]) ** 2 for i in range(a + 1, b))
            rmssd = (d2 / (N - 1)) ** 0.5
            dc, anchors = deceleration_capacity(rrc, bad, a, b)
            out.append({
                "t": round(t0 + REST_WIN_S / 2, 1), "ses": ses, "beats": N,
                "hr": round(60000 / mean, 2), "rmssd": round(rmssd, 2),
                "ln": round(math.log(rmssd), 4) if rmssd > 0 else None,
                "sdnn": round(sdnn, 2), "dc": None if dc is None else round(dc, 3),
                "anchors": anchors, "bad": round(nb / N, 4), "still": st,
            })
            t0 += REST_WIN_S
        else:
            t0 += REST_STEP_S
    return out


def rest_windows(outdir):
    """All resting windows of all sessions, oldest first (see above). Cached
    per session on the rr and accel files' size and mtime."""
    out = []
    for s in sorted(list_sessions(outdir), key=lambda d: d["id"]):
        ses = s["id"]
        keys = []
        for p in (f"rr_{ses}.csv", f"accel_{ses}.csv"):
            try:
                st = os.stat(os.path.join(outdir, p))
                keys.append((st.st_size, st.st_mtime))
            except OSError:
                keys.append(None)
        hit = _rest_cache.get(ses)
        if not hit or hit[0] != keys:
            hit = (keys, _session_rest(outdir, ses))
            _rest_cache[ses] = hit
        out.extend(hit[1])
    return out
