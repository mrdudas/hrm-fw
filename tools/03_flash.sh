#!/bin/bash
# STEP 3 — flash our built firmware onto the strap.
set -eu
PYOCD="/tmp/claude-1000/-home-zsolt/fa3f28b3-7932-483e-ac9d-8a637c34ff52/scratchpad/venv/bin/pyocd"
HEX="/home/zsolt/hrm-fw/build/zephyr/zephyr.hex"

[ -f "$HEX" ] || { echo "build first: see tools/BUILD.sh"; exit 1; }

# Prefer the exact part if the pack is installed, else the generic nrf52 target.
if "$PYOCD" list --targets 2>/dev/null | grep -qi nrf52805; then T=nrf52805; else T=nrf52; fi
echo "flashing with target=$T"
"$PYOCD" flash -t "$T" --frequency 1000000 "$HEX"
echo "done. Reset the board (re-plug battery) and it should advertise 'HRM Raw RR'."
