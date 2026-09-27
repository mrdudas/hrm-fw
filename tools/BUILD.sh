#!/bin/bash
# Build the firmware for the custom nRF52805 strap board.
set -eu

export ZEPHYR_BASE=/home/zsolt/zephyrproject/zephyr
# Use the pre-downloaded Zephyr-SDK ARM GCC directly as a cross compiler.
export ZEPHYR_TOOLCHAIN_VARIANT=cross-compile
export CROSS_COMPILE=/home/zsolt/zephyr-sdk-dl/arm-zephyr-eabi/bin/arm-zephyr-eabi-

WEST=/home/zsolt/zephyr-venv/bin/west
PROJ=/home/zsolt/hrm-fw

cd "$PROJ"
"$WEST" build -p auto -b decathlon_hrm --build-dir "$PROJ/build" "$PROJ" \
	-- -DBOARD_ROOT="$PROJ"

echo
echo "== size =="
arm_size=/home/zsolt/zephyr-sdk-dl/arm-zephyr-eabi/bin/arm-zephyr-eabi-size
"$arm_size" "$PROJ/build/zephyr/zephyr.elf" || true
echo
echo "artifact: $PROJ/build/zephyr/zephyr.hex"
