"""Pure byte-layout parsers for every stream.

These mirror the exact layouts used by the scripts in ~/hrm-fw/host/ so the app
and the reference tools stay consistent. Each function takes raw `bytes` and
returns a plain dict; no I/O, easy to unit test.
"""
import struct

from config import ECTOPY_TYPES


def parse_hr(b: bytes) -> dict:
    """Heart Rate Measurement, char 0x2A37.

    flags byte: bit0 = HR is uint16 (else uint8), bit1/2 = contact,
    bit3 = energy expended present, bit4 = RR intervals present.
    RR values are in 1/1024 s units -> convert to ms via /1024*1000.
    """
    b = bytes(b)
    f = b[0]
    i = 1
    if f & 1:
        hr = int.from_bytes(b[1:3], "little"); i = 3
    else:
        hr = b[1]; i = 2
    contact = ("n/a" if not f & 4 else ("yes" if f & 2 else "no"))
    if f & 8:                     # energy expended present, skip 2 bytes
        i += 2
    rr = []
    if f & 16:
        while i + 1 < len(b):
            rr.append(int.from_bytes(b[i:i + 2], "little") / 1024 * 1000)
            i += 2
    return {"flags": f, "hr": hr, "contact": contact, "rr": rr}


def parse_ecg_info(b: bytes) -> dict:
    """ECG stream info, char a1b20003 (read once on connect), little-endian:
    u16 sample_hz, u16 raw_batch, u8 sample_bytes, u8 fmt_ver
    [+ u16 acc_div: accel is read every acc_div ECG ticks -- 8-byte firmware]."""
    b = bytes(b)
    hz, batch, nbytes, ver = struct.unpack_from("<HHBB", b, 0)
    d = {"sample_hz": hz, "raw_batch": batch, "sample_bytes": nbytes, "fmt_ver": ver}
    if len(b) >= 8:
        d["acc_div"] = struct.unpack_from("<H", b, 6)[0]
    return d


def parse_link(b: bytes) -> dict:
    """Link diagnostics, char a1b20004 (read), little-endian u16 x4: connection
    interval (1.25 ms units), peripheral latency, supervision timeout (10 ms
    units), ATT MTU -- what the strap actually got from the central
    [+ u8 conn_count: centrals connected right now -- 9-byte firmware]
    [+ u8 raw owner of the raw ECG stream: 0 none, 1 this connection, 2 another
       connection -- 10-byte firmware; one host gets raw ECG, last subscriber wins]."""
    b = bytes(b)
    iv, lat, tmo, mtu = struct.unpack_from("<HHHH", b, 0)
    d = {"interval_ms": iv * 1.25, "latency": lat, "timeout_ms": tmo * 10, "mtu": mtu}
    if len(b) >= 9:
        d["conn_count"] = b[8]
    if len(b) >= 10:
        d["raw_owner"] = {0: "none", 1: "mine", 2: "other"}.get(b[9], "other")
    return d


def parse_ecg(b: bytes):
    """Raw ECG, char a1b20002: uint16 seq/tag + N x 16-bit samples at the rate
    reported by a1b20003 (250 Hz on older firmware). Parsed as int16 so a slightly
    negative SAADC reading (sent as its uint16 two's complement) stays negative."""
    b = bytes(b)
    seq = struct.unpack_from("<H", b, 0)[0]
    samples = [struct.unpack_from("<h", b, i)[0] for i in range(2, len(b) - 1, 2)]
    return seq, samples


def parse_accel(b: bytes) -> dict:
    """Accelerometer, char a1b30002, ~25 Hz. Three layouts, told apart by length:

    legacy (8 B):        int16 x, y, z + uint16 step_count      (one sample)
    v1 (3 + 6n B):       uint8 n, n x (int16 x, y, z), uint16 step_count of the
                         last sample                             (n samples, oldest first)
    v2 (6 + 6n B):       v1 + uint16 ecg_seq + uint8 ecg_off: the ECG position
                         (packet seq, offset in it) of the LAST accel sample, so
                         accel can be placed on the ECG timebase exactly

    Returns {"samples": [(x, y, z), ...], "steps": int[, "ecg_seq", "ecg_off"]}.
    """
    b = bytes(b)
    if len(b) == 8:
        x, y, z, steps = struct.unpack_from("<hhhH", b, 0)
        return {"samples": [(x, y, z)], "steps": steps}
    n = b[0]
    v2 = len(b) == 6 + 6 * n
    if n == 0 or not (v2 or len(b) == 3 + 6 * n):
        raise ValueError(f"bad accel packet: {len(b)} B, n={n}")
    samples = [struct.unpack_from("<hhh", b, 1 + 6 * k) for k in range(n)]
    steps = struct.unpack_from("<H", b, 1 + 6 * n)[0]
    d = {"samples": samples, "steps": steps}
    if v2:
        d["ecg_seq"], d["ecg_off"] = struct.unpack_from("<HB", b, 3 + 6 * n)
    return d


def parse_ectopy(b: bytes) -> dict:
    """Ectopy/extrasystole, char a1b40002 (14 B LE):

    u8 type, u8 flags, u16 coupling_ms, u16 pause_ms,
    u16 pvc_count, u16 pac_count, u16 artifact_count, u16 total_beats.
    burden% = 100 * (pvc + pac) / total.
    """
    b = bytes(b)
    t, fl, coup, pause, pvc, pac, art, tot = struct.unpack("<BBHHHHHH", b[:14])
    burden = (100.0 * (pvc + pac) / tot) if tot else 0.0
    return {
        "etype": t,
        "type_name": ECTOPY_TYPES.get(t, str(t)),
        "flags": fl,
        "coupling_ms": coup,
        "pause_ms": pause,
        "pvc": pvc,
        "pac": pac,
        "artifact": art,
        "total": tot,
        "burden_pct": round(burden, 2),
    }


def parse_battery(b: bytes) -> dict:
    """Battery Level, char 0x2A19: 1 byte percent."""
    b = bytes(b)
    return {"pct": b[0] if b else None}
