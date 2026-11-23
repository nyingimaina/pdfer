#!/usr/bin/env bash
# Verifies that the embedded renderer stops when idle and restarts on demand.
#
#   ./scripts/verify-idle-stop.sh [image]
#
# Uses `memory.stat`'s anon figure: `docker stats` includes page cache, which
# makes an idle container look far heavier than it is.
set -euo pipefail

IMAGE="${1:-nyingi/pdfer:1.1.1}"
NAME=pdfer-idle-test
PORT="${PORT:-18098}"
PAYLOAD=$(mktemp)
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "${NAME}-data" >/dev/null 2>&1 || true; rm -f "$PAYLOAD"' EXIT

cat >"$PAYLOAD" <<'JSON'
{"tenant":"demo","documentType":"invoice","mode":"preview","template":"default",
 "useSampleData":true,"generatedAt":"2026-01-31T09:00:00Z"}
JSON

echo "starting $IMAGE with an 8s idle window"
docker run -d --name "$NAME" -p "${PORT}:8080" -v "${NAME}-data:/data" \
  -e PDFER_RENDERER_IDLE_STOP_SECONDS=8 "$IMAGE" >/dev/null

for _ in $(seq 1 90); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/healthz")" = "200" ] && break
  sleep 1
done

echo "waiting for the renderer to stop"
for _ in $(seq 1 60); do
  [ "$(docker exec "$NAME" sh -c 'pgrep -c gotenberg || true')" = "0" ] && break
  sleep 1
done
[ "$(docker exec "$NAME" sh -c 'pgrep -c gotenberg || true')" = "0" ] || {
  echo "FAIL: renderer never stopped"; exit 1; }

echo "renderer stopped; processes:"
docker exec "$NAME" sh -c 'ps -eo rss,comm --sort=-rss | head -5'
echo "cgroup anonymous memory:"
docker exec "$NAME" sh -c 'grep -E "^(anon|file) " /sys/fs/cgroup/memory.stat'

READY=$(curl -s "http://localhost:${PORT}/readyz")
echo "$READY"
echo "$READY" | grep -q '"idle"' || { echo "FAIL: readyz does not report idle"; exit 1; }

echo "rendering after the idle stop"
code=$(curl -s -o /tmp/idle-stop.pdf -w '%{http_code}' -X POST "http://localhost:${PORT}/render" \
  -H 'content-type: application/json' --data-binary "@$PAYLOAD")
[ "$code" = "200" ] || { echo "FAIL: render after idle returned $code"; exit 1; }
head -c 5 /tmp/idle-stop.pdf | grep -q '%PDF-' || { echo "FAIL: not a PDF"; exit 1; }
rm -f /tmp/idle-stop.pdf

for _ in $(seq 1 30); do
  [ "$(docker exec "$NAME" sh -c 'pgrep -c gotenberg || true')" != "0" ] && break
  sleep 1
done
[ "$(docker exec "$NAME" sh -c 'pgrep -c gotenberg || true')" != "0" ] || {
  echo "FAIL: renderer did not restart"; exit 1; }

echo "PASS: stopped when idle, restarted on demand, rendered a PDF"
