"""Shared constants: BLE UUIDs, device name, sample rates.

These match the custom "HRM Raw RR" firmware in ~/hrm-fw and the parsing logic
in ~/hrm-fw/host/. Keep them in sync with the firmware GATT table.
"""

# Advertised device name (primary discovery mechanism, works cross-platform)
DEVICE_NAME = "HRM Raw RR"

# A known address seen on Linux; on macOS the address is an opaque UUID, so we
# always prefer name-based discovery and treat this only as a convenience match.
KNOWN_ADDRESS = "D7:CD:02:7A:05:33"

# Characteristic UUIDs
HR_UUID      = "00002a37-0000-1000-8000-00805f9b34fb"  # Heart Rate Measurement
ECG_UUID     = "a1b20002-0000-1000-8000-00805f9b34fb"  # raw ECG: seq + 20x int16
ECG_INFO_UUID = "a1b20003-0000-1000-8000-00805f9b34fb" # read: u16 sample_hz, u16 raw_batch, u8 sample_bytes, u8 fmt_ver
ACCEL_UUID   = "a1b30002-0000-1000-8000-00805f9b34fb"  # int16 x,y,z + uint16 steps
ECTOPY_UUID  = "a1b40002-0000-1000-8000-00805f9b34fb"  # extrasystole classifier
BATTERY_UUID = "00002a19-0000-1000-8000-00805f9b34fb"  # Battery Level (0x2A19)

# Every stream we try to subscribe to. Missing ones are logged and skipped.
NOTIFY_UUIDS = [HR_UUID, ECG_UUID, ACCEL_UUID, ECTOPY_UUID, BATTERY_UUID]

# Sample rates
ECG_FS   = 250     # Hz, raw ECG default (older firmware without the a1b20003 info char)
ACCEL_FS = 25.0    # Hz, accelerometer (informational)

ECG_SAMPLES_PER_PACKET = 20

ECTOPY_TYPES = {0: "NONE", 1: "PVC", 2: "PAC", 3: "ARTIFACT"}

# Default web server bind
HOST = "127.0.0.1"
PORT = 8770          # uncommon port to avoid clashes; override with --port
