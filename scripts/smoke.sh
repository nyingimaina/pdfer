#!/usr/bin/env bash
# PDfEr container smoke test (SPEC T-21 … T-29, abbreviated).
#
#   bash scripts/smoke.sh [base-url] [tenant] [out-dir]
#
# Requires: curl, python3. Runs against a live container; creates and removes
# nothing outside the tenant it is given.
set -euo pipefail

BASE="${1:-http://localhost:8080}"
TENANT="${2:-demo}"
OUT="${3:-./smoke-out}"
mkdir -p "$OUT"

pass=0
fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected $2, got $1)"; fi; }

json() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1"; }

echo "PDfEr smoke test → $BASE (tenant: $TENANT)"

echo -n "  waiting for readiness"
for _ in $(seq 1 120); do
  if curl -sf -o /dev/null "$BASE/healthz" 2>/dev/null; then break; fi
  printf '.'
  sleep 1
done
echo

# ---------------------------------------------------------------- readiness
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz" || true)
check "$code" 200 "liveness"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/readyz" || true)
check "$code" 200 "readiness (renderer + storage)"

# ---------------------------------------------------------------- catalogue
types=$(curl -s "$BASE/document-types?tenant=$TENANT")
count=$(printf '%s' "$types" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
[ "$count" -ge 1 ] && ok "document-types listed ($count)" || bad "document-types empty"

schema=$(curl -s "$BASE/document-types/invoice/placeholders")
reserved=$(printf '%s' "$schema" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(sum(1 for n in d["root"] if n.get("reserved")))')
check "$reserved" 3 "reserved tokens exposed (generatedAt, documentType, title)"

sample=$(curl -s "$BASE/document-types/invoice/sample-data")
[ -n "$sample" ] && ok "sample-data returned" || bad "sample-data missing"

# ---------------------------------------------------------------- validation
report=$(curl -s -X POST "$BASE/validate" -H 'content-type: application/json' -d "{
  \"tenant\": \"$TENANT\", \"documentType\": \"invoice\",
  \"inlineTemplate\": { \"syntaxId\": \"liquid\", \"content\": \"<p>{{ issuedOnn }}</p>\" }
}")
renderable=$(printf '%s' "$report" | json "['isRenderable']")
check "$renderable" False "validate rejects an unknown token with 200"
suggestion=$(printf '%s' "$report" | json "['unknownTokens'][0].get('suggestion')")
check "$suggestion" issuedOn "near-miss suggestion"

unsafe=$(curl -s -X POST "$BASE/validate" -H 'content-type: application/json' -d "{
  \"tenant\": \"$TENANT\", \"documentType\": \"invoice\",
  \"inlineTemplate\": { \"syntaxId\": \"liquid\", \"content\": \"<script>alert(1)</script>\" }
}")
code_unsafe=$(printf '%s' "$unsafe" | json "['syntaxErrors'][0]['code']")
check "$code_unsafe" UNSAFE_MARKUP "script is rejected statically"

# ---------------------------------------------------------------- render
payload="{
  \"tenant\": \"$TENANT\",
  \"documentType\": \"invoice\",
  \"mode\": \"production\",
  \"template\": \"default\",
  \"generatedAt\": \"2026-01-31T09:00:00Z\",
  \"options\": { \"footerTemplateRef\": \"default\" },
  \"data\": {
    \"invoiceNumber\": \"INV-0000\",
    \"issuedOn\": \"2026-01-31\",
    \"customerName\": \"EXAMPLE CUSTOMER\",
    \"items\": [ { \"description\": \"EXAMPLE ITEM\", \"quantity\": 2, \"unitPrice\": 500, \"lineTotal\": 1000 } ],
    \"total\": 1000
  }
}"

headers=$(curl -s -D "$OUT/headers.txt" -o "$OUT/invoice.pdf" -X POST "$BASE/render" \
  -H 'content-type: application/json' -d "$payload" -w '%{http_code}')
check "$headers" 200 "production render"
head -c 5 "$OUT/invoice.pdf" | grep -q '%PDF-' && ok "response is a PDF" || bad "not a PDF"
pages=$(grep -i '^x-page-count:' "$OUT/headers.txt" | tr -d '\r' | awk '{print $2}')
[ -n "$pages" ] && ok "page count header ($pages)" || bad "missing x-page-count"
grep -qi '^x-template-version:' "$OUT/headers.txt" && ok "template version pinned" || bad "missing provenance"
grep -qi '^x-input-hash: sha256:' "$OUT/headers.txt" && ok "input hash recorded" || bad "missing input hash"
handle=$(grep -i '^x-artifact-handle:' "$OUT/headers.txt" | tr -d '\r' | awk '{print $2}')

code=$(curl -s -o "$OUT/artifact.pdf" -w '%{http_code}' "$BASE/artifacts/$handle?tenant=$TENANT")
check "$code" 200 "artifact is retrievable"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/artifacts/$handle?tenant=other")
check "$code" 404 "artifact is tenant-scoped"

# ---------------------------------------------------------------- preview
code=$(curl -s -D "$OUT/prev-headers.txt" -o "$OUT/preview.pdf" -w '%{http_code}' -X POST "$BASE/preview" \
  -H 'content-type: application/json' -d "{
    \"tenant\": \"$TENANT\", \"documentType\": \"invoice\", \"template\": \"default\",
    \"useSampleData\": true, \"generatedAt\": \"2026-01-31T09:00:00Z\"
  }")
check "$code" 200 "preview with sample data needs no business data"
grep -qi '^x-artifact-handle:' "$OUT/prev-headers.txt" && bad "preview persisted an artifact" || ok "preview wrote nothing"

# ---------------------------------------------------------------- lifecycle
# Uses a throwaway tenant so the demo default is never retired.
SMOKE_TENANT="${TENANT}-smoke"
saved=$(curl -s -X POST "$BASE/templates" -H 'content-type: application/json' -d "{
  \"tenant\": \"$SMOKE_TENANT\", \"documentType\": \"invoice\",
  \"content\": \"<p>{{ invoiceNumber }}</p>\", \"displayLabel\": \"smoke\"
}")
tid=$(printf '%s' "$saved" | json "['templateId']")
ver=$(printf '%s' "$saved" | json "['version']")
[ -n "$tid" ] && ok "template saved (v$ver)" || bad "template save failed"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/templates/$tid/versions/$ver/publish?tenant=$SMOKE_TENANT")
check "$code" 204 "publish"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/templates/$tid/versions/$ver/default?tenant=$SMOKE_TENANT")
check "$code" 204 "set default"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/templates/$tid?tenant=other&version=$ver")
check "$code" 404 "templates are tenant-scoped"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/templates/$tid/versions/$ver/retire?tenant=$SMOKE_TENANT")
check "$code" 204 "retire"

# ---------------------------------------------------------------- errors
code=$(curl -s -o "$OUT/err.json" -w '%{http_code}' -X POST "$BASE/render" \
  -H 'content-type: application/json' -d "{
    \"tenant\": \"$SMOKE_TENANT\", \"documentType\": \"invoice\", \"mode\": \"production\",
    \"template\": \"default\", \"data\": { \"invoiceNumber\": \"X\", \"issuedOn\": \"2026-01-01\", \"customerName\": \"C\", \"total\": 1 },
    \"generatedAt\": \"2026-01-31T09:00:00Z\"
  }")
check "$code" 404 "retired default → NO_DEFAULT_TEMPLATE"
err=$(json "['error']['code']" < "$OUT/err.json")
check "$err" NO_DEFAULT_TEMPLATE "error code is stable"

async=$(curl -s -X POST "$BASE/render?async=true" -H 'content-type: application/json' -d "$payload")
job=$(printf '%s' "$async" | json "['jobId']")
[ -n "$job" ] && ok "async render accepted ($job)" || bad "async render not accepted"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/render" \
  -H 'content-type: application/json' -d '{"tenant":')
check "$code" 422 "unparseable body is 422"

# ---------------------------------------------------------------- metrics
curl -s "$BASE/metrics" | grep -q 'pdfer_render_duration_seconds_bucket' && ok "latency histogram exposed" || bad "latency histogram missing"
curl -s "$BASE/metrics" | grep -q 'pdfer_render_queue_depth' && ok "queue depth gauge exposed" || bad "queue gauge missing"
curl -s "$BASE/metrics" | grep -q 'pdfer_renders_total{outcome="ok"}' && ok "metrics exposed" || bad "metrics missing"
curl -s "$BASE/metrics" | grep -q "$TENANT" && bad "metrics leak tenant" || ok "metrics contain no tenant labels"

# ---------------------------------------------------------------- hardening
grep -qi '^x-content-type-options: nosniff' "$OUT/headers.txt" && ok "nosniff header" || bad "missing nosniff"
grep -qi '^cache-control: no-store' "$OUT/headers.txt" && ok "artifact responses are not cacheable" || bad "missing cache-control"
grep -qi '^referrer-policy: no-referrer' "$OUT/headers.txt" && ok "referrer-policy header" || bad "missing referrer-policy"

echo
printf 'smoke: \033[32m%d passed\033[0m, ' "$pass"
if [ "$fail" -gt 0 ]; then printf '\033[31m%d failed\033[0m\n' "$fail"; exit 1; fi
printf '0 failed\n'
