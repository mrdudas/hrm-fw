#!/usr/bin/env bash
# HRM Raw RR dashboard — installer for Linux and macOS.
#
#   ./install.sh            create .venv and install the requirements
#   ./install.sh --force    recreate .venv from scratch
#
# Afterwards start the app with ./run.sh (any app.py options pass through,
# e.g. ./run.sh --demo).
set -euo pipefail

MIN_MAJOR=3
MIN_MINOR=10

cd "$(dirname "$0")"
APP_DIR="$(pwd)"
VENV="$APP_DIR/.venv"
OS="$(uname -s)"

info() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

# ---- 1. find a Python >= 3.10 ------------------------------------------------
python_ok() {
  "$1" -c "import sys; sys.exit(0 if sys.version_info >= ($MIN_MAJOR, $MIN_MINOR) else 1)" 2>/dev/null
}

PY=""
for cand in python3.13 python3.12 python3.11 python3.10 python3 python; do
  if command -v "$cand" >/dev/null 2>&1 && python_ok "$cand"; then
    PY="$(command -v "$cand")"
    break
  fi
done

if [ -z "$PY" ]; then
  case "$OS" in
    Darwin) die "Python >= $MIN_MAJOR.$MIN_MINOR not found. Install it with 'brew install python' or from https://www.python.org/downloads/macos/" ;;
    Linux)  die "Python >= $MIN_MAJOR.$MIN_MINOR not found. Install it, e.g. 'sudo apt install python3 python3-venv' (Debian/Ubuntu), 'sudo dnf install python3' (Fedora) or 'sudo pacman -S python' (Arch)." ;;
    *)      die "Python >= $MIN_MAJOR.$MIN_MINOR not found." ;;
  esac
fi
info "using $("$PY" --version 2>&1) ($PY)"

# ---- 2. virtual environment ----------------------------------------------------
if [ "$FORCE" = 1 ] && [ -d "$VENV" ]; then
  info "removing existing .venv"
  rm -rf "$VENV"
fi

if [ -x "$VENV/bin/python" ] && python_ok "$VENV/bin/python"; then
  info "reusing existing .venv"
else
  [ -d "$VENV" ] && { info "existing .venv is broken or too old, recreating"; rm -rf "$VENV"; }
  info "creating .venv"
  if ! "$PY" -m venv "$VENV"; then
    rm -rf "$VENV"
    if [ "$OS" = Linux ]; then
      ver="$("$PY" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
      die "could not create the virtual environment. On Debian/Ubuntu install the venv module: sudo apt install python3-venv (or python$ver-venv)"
    fi
    die "could not create the virtual environment"
  fi
fi

# ---- 3. dependencies --------------------------------------------------------------
info "installing requirements"
"$VENV/bin/python" -m pip install --upgrade pip --quiet
"$VENV/bin/python" -m pip install -r requirements.txt --quiet
"$VENV/bin/python" -c "import bleak, aiohttp" || die "requirements did not install correctly"

mkdir -p recordings
chmod +x run.sh 2>/dev/null || true

# ---- 4. Bluetooth sanity checks (warnings only) ---------------------------------------
if [ "$OS" = Linux ]; then
  if command -v systemctl >/dev/null 2>&1; then
    if ! systemctl is-active --quiet bluetooth 2>/dev/null; then
      warn "the bluetooth service is not running. Start it with: sudo systemctl enable --now bluetooth"
    fi
  elif ! pgrep -x bluetoothd >/dev/null 2>&1; then
    warn "bluetoothd (BlueZ) does not seem to be running"
  fi
  if command -v rfkill >/dev/null 2>&1 && rfkill list bluetooth 2>/dev/null | grep -q "blocked: yes"; then
    warn "Bluetooth is blocked by rfkill. Unblock it with: rfkill unblock bluetooth"
  fi
elif [ "$OS" = Darwin ]; then
  info "macOS: on the first run allow Bluetooth access for your terminal app"
  info "       (System Settings > Privacy & Security > Bluetooth)"
fi

echo
info "done. Start the dashboard with:"
echo "    ./run.sh            # connect to the strap"
echo "    ./run.sh --demo     # synthetic data, no hardware needed"
