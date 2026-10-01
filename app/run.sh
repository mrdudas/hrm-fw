#!/usr/bin/env bash
# Start the HRM Raw RR dashboard from the local .venv (run ./install.sh first).
# All options are passed to app.py, e.g. ./run.sh --demo
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "error: .venv not found — run ./install.sh first" >&2
  exit 1
fi
exec .venv/bin/python app.py "$@"
