#!/usr/bin/env python3
"""Design the ECG detector's IIR filters for a given sample rate.

The firmware (src/main.c) hard-codes NOTCH_b/a (50 Hz mains notch) and BP_b/a
(8-22 Hz band-pass) for one specific fs. Changing SAMPLE_HZ requires regenerating
them. Usage:  python3 host/filter_design.py [fs]   (default fs=250, the current).

Prints C initializers ready to paste, and verifies that fs=250 reproduces the
coefficients currently in the firmware."""
import sys
import numpy as np
from scipy.signal import iirnotch, butter

fs = float(sys.argv[1]) if len(sys.argv) > 1 else 250.0

NOTCH_HZ = 50.0
NOTCH_Q  = 30.0         # reproduces the firmware r~=0.9794 at fs=250
BP_LO, BP_HI = 8.0, 22.0
BP_ORDER = 2             # butter order; band-pass doubles it -> 4th order, 5 taps

bn, an = iirnotch(NOTCH_HZ, NOTCH_Q, fs=fs)
bb, ab = butter(BP_ORDER, [BP_LO, BP_HI], btype='band', fs=fs)

def c(name, v):
    return f"static const float {name}[] = {{" + ", ".join(f"{x:.8f}f" for x in v) + "};"

print(f"/* fs = {fs:g} Hz  (50 Hz notch Q={NOTCH_Q}, {BP_LO:g}-{BP_HI:g} Hz band-pass, order {2*BP_ORDER}) */")
print(c("NOTCH_b", bn)); print(c("NOTCH_a", an))
print(c("BP_b", bb));    print(c("BP_a", ab))

if abs(fs - 250.0) < 1e-6:
    cur_a = np.array([1.0, -0.60535364, 0.95896552])     # current firmware NOTCH_a
    err = np.max(np.abs(an - cur_a))
    print(f"\n// sanity vs firmware NOTCH_a: max|delta| = {err:.5f} "
          f"({'OK' if err < 5e-3 else 'MISMATCH -- adjust NOTCH_Q'})")
