#!/usr/bin/env python3
"""HRM Raw RR dashboard + recorder.

Connects to the custom BLE heart-rate strap ("HRM Raw RR"), records every stream
to timestamped CSV files under recordings/, and serves a live dashboard at
http://localhost:8770.

Usage:
    python app.py                 # scan for the strap and stream live
    python app.py --demo          # synthetic data, no hardware needed
    python app.py --scan          # list nearby BLE devices and exit
    python app.py --address ADDR  # connect to a specific address/UUID
    python app.py --no-open       # don't auto-open the browser
    python app.py --port 8770     # change the web server port
"""
import argparse
import asyncio
import os
import sys
import time
import webbrowser

from config import HOST, PORT, DEVICE_NAME, LEGACY_NAMES
from recorder import CSVRecorder
from hub import Hub
from webserver import make_app, start_server

RECORDINGS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "recordings")


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


async def run_scan():
    from ble_source import scan_devices
    log("scanning 6s for BLE devices ...")
    try:
        devs = await scan_devices()
    except Exception as e:
        log(f"scan failed: {e}")
        log("On Linux make sure bluetoothd/BlueZ is running and BLE is enabled.")
        return
    if not devs:
        log("no devices found.")
        return
    print(f"\n{'address':40}  rssi  name")
    for addr, name, rssi in devs:
        mark = "  <-- looks like the strap" if name in (DEVICE_NAME, *LEGACY_NAMES) else ""
        print(f"{addr:40}  {str(rssi):>4}  {name}{mark}")


async def run_dashboard(args):
    session = time.strftime("%Y%m%d_%H%M%S")
    recorder = CSVRecorder(RECORDINGS_DIR, session)
    hub = Hub(recorder)

    app = make_app(hub)
    runner = await start_server(app, args.host, args.port)
    url = f"http://{args.host}:{args.port}"
    log(f"dashboard at {url}")
    log(f"recording to {RECORDINGS_DIR}/*_{session}.csv")

    broadcaster = asyncio.create_task(hub.broadcaster())

    # pick the data source
    if args.demo:
        from demo_source import DemoSource
        source = DemoSource(hub, log=log, fs=args.demo_fs, batch=args.demo_batch)
    else:
        try:
            import bleak  # noqa: F401
        except ImportError:
            log("ERROR: bleak is not installed. Install requirements or use --demo.")
            log("  pip install -r requirements.txt")
            await runner.cleanup()
            recorder.close()
            return
        from ble_source import BLESource
        source = BLESource(hub, name=args.name, address=args.address, log=log)

    hub.source = source
    source_task = asyncio.create_task(source.run())

    if not args.no_open:
        # open the browser shortly after the server is up
        async def _open():
            await asyncio.sleep(0.6)
            try:
                webbrowser.open(url)
            except Exception:
                pass
        asyncio.create_task(_open())

    log("running. Press Ctrl+C to stop.")
    try:
        await source_task
    except asyncio.CancelledError:
        pass
    finally:
        source.stop()
        broadcaster.cancel()
        await runner.cleanup()
        recorder.close()
        log("stopped; CSV files closed.")


def parse_args(argv):
    p = argparse.ArgumentParser(description="HRM Raw RR dashboard + recorder")
    p.add_argument("--demo", action="store_true",
                   help="stream synthetic data (no BLE hardware needed)")
    p.add_argument("--demo-fs", type=int, default=250, choices=(250, 500, 1024),
                   help="ECG sample rate simulated by --demo (default 250)")
    p.add_argument("--demo-batch", type=int, default=20, choices=(20, 30, 40, 64),
                   help="ECG samples per packet simulated by --demo (default 20)")
    p.add_argument("--scan", action="store_true",
                   help="list nearby BLE devices and exit")
    p.add_argument("--name", default=DEVICE_NAME,
                   help=f"device name to scan for (default: {DEVICE_NAME!r})")
    p.add_argument("--address", default=None,
                   help="connect to a specific BLE address / macOS UUID")
    p.add_argument("--host", default=HOST, help=f"web bind host (default {HOST})")
    p.add_argument("--port", type=int, default=PORT,
                   help=f"web port (default {PORT})")
    p.add_argument("--no-open", action="store_true",
                   help="do not auto-open the browser")
    return p.parse_args(argv)


def main():
    args = parse_args(sys.argv[1:])
    try:
        if args.scan:
            asyncio.run(run_scan())
        else:
            asyncio.run(run_dashboard(args))
    except KeyboardInterrupt:
        print("\ninterrupted.")


if __name__ == "__main__":
    main()
