"""Open the dashboard in a browser.

Everywhere but on a dual-GPU Mac this is just the default browser.

On a MacBook Pro with a second (discrete) GPU, Chrome draws 2D canvases on
the integrated Intel GPU, where strokes wider than one device pixel are
rasterised on the CPU: the old 1.2 px ECG trace kept a whole core busy in
Chrome's GPU process (~42 fps) on a 2016 15" model. The page therefore
defaults to software canvases and one-device-pixel traces. With the discrete
GPU the wide trace is cheap (11-12 % of a core, flat memory), but only a
command line switch of a freshly started Chrome selects it -- the page cannot
ask for it, and a Chrome that is already running ignores the switch. So on
such a Mac the dashboard gets its own Chrome window: separate profile,
discrete GPU forced, GPU canvases and the wide trace switched on in the URL.
`--browser default` keeps the default browser (the discrete GPU draws more
power on battery).
"""
import json
import os
import subprocess
import sys
import webbrowser

CHROME_APP = "/Applications/Google Chrome.app"
# persistent, so the page's settings (localStorage) survive
PROFILE_DIR = os.path.expanduser("~/Library/Application Support/HRM Raw RR/chrome-profile")
GPU_QUERY = "sw=0&lw=1.2"       # GPU canvases, traces 1.2 CSS px wide


def gpu_count() -> int:
    """Number of graphics chipsets macOS lists (0 if it cannot be told)."""
    try:
        out = subprocess.run(["system_profiler", "SPDisplaysDataType", "-json"],
                             capture_output=True, timeout=10, check=True).stdout
        return len(json.loads(out).get("SPDisplaysDataType", []))
    except Exception:
        return 0


def chrome_gpu_command(url: str) -> list:
    sep = "&" if "?" in url else "?"
    return ["open", "-na", "Google Chrome", "--args",
            f"--user-data-dir={PROFILE_DIR}", "--force_high_performance_gpu",
            "--no-first-run", "--no-default-browser-check",
            f"--app={url}{sep}{GPU_QUERY}"]


def use_chrome_gpu(mode: str) -> bool:
    """mode: 'auto' (dedicated Chrome on a dual-GPU Mac), 'default', 'chrome-gpu'."""
    if mode == "default" or sys.platform != "darwin" or not os.path.isdir(CHROME_APP):
        return False
    return mode == "chrome-gpu" or gpu_count() >= 2


def open_dashboard(url: str, mode: str = "auto", log=print):
    if use_chrome_gpu(mode):
        try:
            os.makedirs(PROFILE_DIR, exist_ok=True)
            subprocess.run(chrome_gpu_command(url), check=True, timeout=15)
            log("dashboard opened in its own Chrome window on the discrete GPU "
                "(--browser default for the default browser)")
            return
        except Exception as e:
            log(f"could not start the dedicated Chrome window ({e}); using the default browser")
    try:
        webbrowser.open(url)
    except Exception:
        pass
