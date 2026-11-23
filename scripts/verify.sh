#!/usr/bin/env bash
# End-to-end container verification (SPEC §8, T-21 … T-29).
#
#   bash scripts/verify.sh
#
# Builds the image, boots it on a throwaway volume, runs the smoke suite and the
# renderer-supervision test, then reports idle memory.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=pdfer-verify
PORT="${PORT:-18090}"
BASE="http://localhost:$PORT"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "${NAME}-data" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== build =="
docker build -q -t pdfer/pdfer:1.1 .
echo "image: $(docker images pdfer/pdfer:1.1 --format '{{.Size}}')"

echo
echo "== boot =="
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" -v "${NAME}-data:/data" \
  --read-only --tmpfs /tmp:size=512m --security-opt no-new-privileges \
  pdfer/pdfer:1.1 >/dev/null

bash scripts/smoke.sh "$BASE" demo /tmp/pdfer-smoke

echo
echo "== renderer supervision =="
bash scripts/renderer-supervision-test.sh "$NAME" "$BASE"

echo
echo "== resources =="
docker stats "$NAME" --no-stream --format 'idle memory: {{.MemUsage}}  cpu: {{.CPUPerc}}'
