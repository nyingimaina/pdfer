#!/usr/bin/env bash
# Verifies the asset pipeline end to end, against a real renderer.
#
#   ./scripts/verify-assets.sh [image]
#
# Checks that
#   * an image referenced as ./assets/<name> is embedded in the PDF (body and
#     footer decorator),
#   * /compile still returns the portable ./assets/... form,
#   * a reference the validator cannot see (srcset) fails the render with
#     RENDER_RESOURCE_FAILED instead of producing a PDF without it,
#   * the seeded demo passes its startup self-test with the strict flag on.
#
# Needs docker, curl and python3 on the host. Run against a local build before
# a release and against the published image after one.
set -euo pipefail

IMAGE="${1:-nyingi/pdfer:1.1.2}"
NAME=pdfer-assets-test
PORT="${PORT:-18092}"
BASE="http://localhost:${PORT}"
TENANT=chk
DIR=$(mktemp -d)

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

cat >"$DIR/schemas.json" <<'JSON'
{"schemas":[
 {"documentType":"asset-check","schemaVersion":1,"root":[{"name":"label","displayLabel":"Label","group":"Body","dataType":"string","isRequired":false,"sampleValue":"x"}]},
 {"documentType":"asset-check-footer","schemaVersion":1,"root":[{"name":"label","displayLabel":"Label","group":"Body","dataType":"string","isRequired":false,"sampleValue":"x"}]}
]}
JSON

python3 - "$DIR/pic.png" <<'PY'
import sys, zlib, struct, random
w, h = 123, 45
random.seed(11)
raw = b"".join(b"\x00" + bytes(random.getrandbits(8) for _ in range(w * 3)) for _ in range(h))
def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(raw, 9))
       + chunk(b"IEND", b""))
open(sys.argv[1], "wb").write(png)
PY

echo "starting $IMAGE (seeding on, so the demo self-test runs)"
docker run -d --name "$NAME" -p "${PORT}:8080" \
  -e PDFER_SCHEMAS_FILE=/config/schemas.json \
  -v "$DIR/schemas.json:/config/schemas.json:ro" "$IMAGE" >/dev/null

for _ in $(seq 1 90); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz" || true)" = "200" ] && break
  sleep 1
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz" || true)" = "200" ] || {
  docker logs --tail 20 "$NAME" || true
  echo "FAIL: engine did not become healthy"
  exit 1
}

docker logs "$NAME" 2>&1 | grep -q 'startup self-test passed' || {
  docker logs --tail 20 "$NAME" || true
  echo "FAIL: the seeded demo did not pass its startup self-test"
  exit 1
}
echo "ok: demo self-test passed"

publish() { # documentType, content -> template id
  local body tid ver saved
  body=$(python3 -c 'import json,sys; print(json.dumps({"tenant":"chk","documentType":sys.argv[1],"syntaxId":"liquid","content":sys.argv[2],"displayLabel":"verify"}))' "$1" "$2")
  saved=$(curl -sf -X POST "$BASE/templates" -H 'content-type: application/json' -d "$body")
  tid=$(printf '%s' "$saved" | python3 -c 'import json,sys; print(json.load(sys.stdin)["templateId"])')
  ver=$(printf '%s' "$saved" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
  curl -sf -o /dev/null -X POST "$BASE/templates/$tid/versions/$ver/publish?tenant=$TENANT"
  curl -sf -o /dev/null -X POST "$BASE/templates/$tid/versions/$ver/default?tenant=$TENANT"
}

render() { # output, extra options json
  curl -s -o "$1" -w '%{http_code}' -X POST "$BASE/render" -H 'content-type: application/json' -d \
    "{\"tenant\":\"$TENANT\",\"documentType\":\"asset-check\",\"mode\":\"preview\",\"template\":\"default\",\"generatedAt\":\"2026-01-01T00:00:00Z\",\"data\":{}$2}"
}

curl -sf -o /dev/null -X PUT "$BASE/assets/assets/pic.png?tenant=$TENANT" \
  -H 'Content-Type: image/png' --data-binary @"$DIR/pic.png"

echo "checking an image in the body"
publish asset-check '<!doctype html><html><body><img src="./assets/pic.png" width="80"></body></html>'
code=$(render "$DIR/main.pdf" '')
[ "$code" = "200" ] || { echo "FAIL: render returned $code"; exit 1; }
grep -aq '/Width 123' "$DIR/main.pdf" || { echo "FAIL: the image is not in the PDF"; exit 1; }
echo "ok: body image embedded"

echo "checking an image in a footer decorator"
publish asset-check-footer '<div style="font-size:8px"><img src="./assets/pic.png" width="20"><span class="pageNumber"></span></div>'
code=$(render "$DIR/footer.pdf" ',"options":{"footerTemplateRef":"default"}')
[ "$code" = "200" ] || { echo "FAIL: footer render returned $code"; exit 1; }
grep -aq '/Width 123' "$DIR/footer.pdf" || { echo "FAIL: the footer image is not in the PDF"; exit 1; }
echo "ok: footer image embedded"

echo "checking that /compile keeps the portable form"
curl -sf -X POST "$BASE/v1/compile" -H 'content-type: application/json' -d \
  '{"tenant":"chk","documentType":"asset-check","template":"default","generatedAt":"2026-01-01T00:00:00Z","data":{}}' >"$DIR/compiled.html"
grep -q '\./assets/pic\.png' "$DIR/compiled.html" || { echo "FAIL: /compile lost the ./assets/ form"; exit 1; }
if grep -Eq '[0-9a-f]{12}-pic\.png' "$DIR/compiled.html"; then
  echo "FAIL: /compile leaked a flattened name"
  exit 1
fi
echo "ok: compile output is portable"

echo "checking that a sub-resource that cannot load fails the render"
publish asset-check '<!doctype html><html><body><img srcset="./assets/missing.png 1x" width="80"></body></html>'
code=$(render "$DIR/negative.json" '')
[ "$code" = "502" ] || { echo "FAIL: expected 502, got $code"; cat "$DIR/negative.json"; exit 1; }
grep -q 'RENDER_RESOURCE_FAILED' "$DIR/negative.json" || {
  echo "FAIL: expected RENDER_RESOURCE_FAILED"; cat "$DIR/negative.json"; exit 1
}
echo "ok: missing sub-resource is a 502 RENDER_RESOURCE_FAILED"

echo "PASS: assets reach the PDF and failures are loud"
