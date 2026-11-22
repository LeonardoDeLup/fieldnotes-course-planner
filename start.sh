#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"
if [ -x "$ROOT/.tools/node/bin/node" ]; then
  PATH="$ROOT/.tools/node/bin:$PATH"
  export PATH
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 22 LTS or newer is required.' >&2
  exit 1
fi
if [ ! -x backend/.venv/bin/python ]; then
  echo 'Create backend/.venv and install backend/requirements.txt first (see README.md).' >&2
  exit 1
fi
if [ ! -d frontend/node_modules ]; then
  echo 'Install frontend dependencies first (see README.md).' >&2
  exit 1
fi

backend/.venv/bin/python - <<'PY'
import errno
import socket
import sys

for port, service in ((8000, 'course API'), (5173, 'frontend')):
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind(('127.0.0.1', port))
        except OSError as error:
            if error.errno != errno.EADDRINUSE:
                raise
            sys.exit(f'Port {port} is already in use. Stop the existing {service} listener before running ./start.sh again.')
PY

API_PID=''
FRONTEND_PID=''
cleanup() {
  if [ -n "$FRONTEND_PID" ]; then kill "$FRONTEND_PID" 2>/dev/null || true; fi
  if [ -n "$API_PID" ]; then kill "$API_PID" 2>/dev/null || true; fi
  if [ -n "$FRONTEND_PID" ]; then wait "$FRONTEND_PID" 2>/dev/null || true; fi
  if [ -n "$API_PID" ]; then wait "$API_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

check_process() {
  if ! kill -0 "$1" 2>/dev/null; then
    echo "The $2 stopped. See the server logs above." >&2
    exit 1
  fi
}

wait_for_catalog() {
  url=$1
  attempt=1
  while [ "$attempt" -le 15 ]; do
    check_process "$API_PID" 'course API'
    if [ -n "$FRONTEND_PID" ]; then check_process "$FRONTEND_PID" frontend; fi
    if headers=$(curl --noproxy '*' -fsS --max-time 2 -D - -o /dev/null "$url/api/courses" 2>/dev/null) &&
      printf '%s\n' "$headers" | grep -Eiq '^x-catalog-revision:[[:blank:]]*[[:xdigit:]]{64}[[:space:]]*$'; then
      return
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "Could not load the catalog from $url. See the server logs above." >&2
  exit 1
}

API_URL=http://127.0.0.1:8000
FRONTEND_URL=http://127.0.0.1:5173
backend/.venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000 &
API_PID=$!
wait_for_catalog "$API_URL"

cd frontend
FIELDNOTES_API_URL="$API_URL" node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort &
FRONTEND_PID=$!
wait_for_catalog "$FRONTEND_URL"
printf 'Fieldnotes is ready at %s\n' "$FRONTEND_URL"

while :; do
  check_process "$API_PID" 'course API'
  check_process "$FRONTEND_PID" frontend
  sleep 1
done
