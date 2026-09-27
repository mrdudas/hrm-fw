#!/bin/bash
# STEP 2 (only if LOCKED) — mass-erase via CTRL-AP to unlock the debug port.
# !!! THIS PERMANENTLY ERASES THE MAGENE FIRMWARE. No going back. !!!
# After this the chip is blank and we flash our own firmware (03_flash.sh).
set -eu
PYOCD="/tmp/claude-1000/-home-zsolt/fa3f28b3-7932-483e-ac9d-8a637c34ff52/scratchpad/venv/bin/pyocd"

read -r -p "Type ERASE to confirm wiping the stock firmware: " ans
[ "$ans" = "ERASE" ] || { echo "aborted"; exit 1; }

# pyOCD triggers the nRF CTRL-AP ERASEALL even when APPROTECT is locked.
"$PYOCD" erase -t nrf52 --mass --frequency 1000000 || {
	echo "pyocd mass-erase failed; fallback needs openocd:"
	echo "  openocd -f interface/stlink.cfg -c 'transport select hla_swd' \\"
	echo "          -f target/nrf52.cfg -c 'init; nrf52_recover; exit'"
	exit 1
}
echo "chip unlocked & blank. Next: 03_flash.sh"
