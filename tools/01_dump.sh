#!/bin/bash
# STEP 1 (only if UNLOCKED) — back up the stock Magene firmware BEFORE any change.
# Saves flash (192 KB), UICR and FICR. Keep these safe: they are the only copy.
set -eu
PYOCD="/tmp/claude-1000/-home-zsolt/fa3f28b3-7932-483e-ac9d-8a637c34ff52/scratchpad/venv/bin/pyocd"
OUT="/home/zsolt/hrm-fw/dump"
mkdir -p "$OUT"

"$PYOCD" cmd -t nrf52 --frequency 1000000 \
	-c "reset halt" \
	-c "savemem 0x00000000 0x30000 $OUT/magene_flash.bin" \
	-c "savemem 0x10000000 0x1000 $OUT/magene_ficr.bin" \
	-c "savemem 0x10001000 0x1000 $OUT/magene_uicr.bin"

echo "saved to $OUT:"
ls -la "$OUT"
echo
echo "Next: we reverse-engineer magene_flash.bin to find & disable the RR smoothing,"
echo "then flash the patched image back — the stock firmware stays intact."
