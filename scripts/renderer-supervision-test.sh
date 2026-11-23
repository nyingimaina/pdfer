#!/usr/bin/env bash
# Renderer supervision test (SPEC T-22, N26/N27).
#
#   bash scripts/renderer-supervision-test.sh [container] [base-url]
#
# Kills the embedded renderer and asserts that liveness stays up, readiness
# drops, and the engine restarts the child without restarting the container.
set -euo pipefail

NAME="${1:-pdfer}"
BASE="${2:-http://localhost:8080}"

code() { curl -s -o /dev/null -w '%{http_code}' "$1" || true; }

pid=$(docker exec "$NAME" sh -c 'for p in /proc/[0-9]*; do
    [ "$(cat "$p/comm" 2>/dev/null)" = "gotenberg" ] && echo "${p#/proc/}" && break
  done' | head -1)

if [ -z "$pid" ]; then
  echo "could not find the renderer process; is it running?"
  exit 1
fi
echo "renderer pid: $pid"

docker exec "$NAME" sh -c "kill -9 $pid"
sleep 0.3

health=$(code "$BASE/healthz")
ready=$(code "$BASE/readyz")
echo "after kill → healthz=$health readyz=$ready"

fail=0
[ "$health" = "200" ] && echo "  ✓ liveness survived the renderer crash" || { echo "  ✗ liveness dropped"; fail=1; }
[ "$ready" = "503" ] && echo "  ✓ readiness reported the renderer as down" || { echo "  ✗ readiness did not report 503 (got $ready)"; fail=1; }

recovered=0
for i in $(seq 1 45); do
  if [ "$(code "$BASE/readyz")" = "200" ]; then
    recovered=$i
    break
  fi
  sleep 1
done

if [ "$recovered" -gt 0 ]; then
  echo "  ✓ renderer restarted (ready after ${recovered}s)"
else
  echo "  ✗ renderer did not recover"
  fail=1
fi

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "supervision: ok"
