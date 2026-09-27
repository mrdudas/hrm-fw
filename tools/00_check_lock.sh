#!/bin/bash
# STEP 0 — READ-ONLY. Is the probe visible and is the chip locked (APPROTECT)?
# Destroys nothing. Run this first once the ST-Link is wired and plugged in.
set -u
PYOCD="/tmp/claude-1000/-home-zsolt/fa3f28b3-7932-483e-ac9d-8a637c34ff52/scratchpad/venv/bin/pyocd"

echo "== probes =="
"$PYOCD" list || { echo "no probe — check USB / GNDDETECT->GND / T_VCC->3V"; exit 1; }

echo
echo "== trying to read FICR (0x10000000) — reads only if UNLOCKED =="
if "$PYOCD" cmd -t nrf52 --frequency 1000000 \
	-c "reset halt" -c "rd 0x10000000 4" -c "rd 0x10000060 1" 2>&1 | tee /tmp/hrm_lock.txt
then
	if grep -qiE "0x10000000:" /tmp/hrm_lock.txt; then
		echo
		echo ">>> UNLOCKED. You can DUMP the stock firmware (01_dump.sh) before touching anything."
	fi
else
	echo
	echo ">>> Looks LOCKED (APPROTECT on). To proceed you must MASS-ERASE"
	echo ">>> (02_recover.sh) — this ERASES the Magene firmware for good."
fi
