#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="$ROOT/engine/.venv/bin/python"
DATA_DIR="$(mktemp -d)"
LOG="$(mktemp)"

cleanup() {
  if [[ -n "${PID:-}" ]]; then
    kill "$PID" >/dev/null 2>&1 || true
    wait "$PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$DATA_DIR" "$LOG"
}
trap cleanup EXIT

PYTHONPATH="$ROOT/engine" "$PY" -m photodedup.server --data-dir "$DATA_DIR" >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 100); do
  if [[ -s "$LOG" ]]; then
    break
  fi
  sleep 0.05
done

HANDSHAKE="$(head -n 1 "$LOG")"
PORT="$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["port"])' "$HANDSHAKE")"
TOKEN="$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["token"])' "$HANDSHAKE")"

echo "handshake=$HANDSHAKE"
echo "healthz=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/healthz")"
echo "groups=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Api-Token: $TOKEN" "http://127.0.0.1:$PORT/groups")"
echo "groups_without_token=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/groups")"
