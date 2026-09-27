#!/bin/bash
# Live firmware logs over SEGGER RTT (shows raw samples / detected beats / RR).
# Great for bring-up: confirms we found the right pin and see a real ECG rhythm.
set -eu
PYOCD="/tmp/claude-1000/-home-zsolt/fa3f28b3-7932-483e-ac9d-8a637c34ff52/scratchpad/venv/bin/pyocd"
if "$PYOCD" list --targets 2>/dev/null | grep -qi nrf52805; then T=nrf52805; else T=nrf52; fi
exec "$PYOCD" rtt -t "$T" --frequency 1000000
