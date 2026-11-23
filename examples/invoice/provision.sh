#!/usr/bin/env bash
# Provisions the example templates into a running engine.
#
#   ./provision.sh [base-url] [tenant]
#
# Requires curl and python3.
set -euo pipefail
cd "$(dirname "$0")"

BASE="${1:-http://localhost:8080}"
TENANT="${2:-demo}"

AUTH=()
if [ -n "${PDFER_API_KEY:-}" ]; then
  AUTH=(-H "Authorization: Bearer ${PDFER_API_KEY}")
fi

ensure() {
  local document_type="$1" file="$2" label="$3"

  local published
  published=$(curl -sf "${AUTH[@]}" \
    "$BASE/templates?tenant=$TENANT&documentType=$document_type&state=published&limit=1" || echo '{}')
  local existing
  existing=$(printf '%s' "$published" | python3 -c \
    'import sys,json; d=json.load(sys.stdin); print(d["items"][0]["templateId"] if d.get("items") else "")')
  if [ -n "$existing" ]; then
    echo "  $document_type already published"
    return
  fi

  local body
  body=$(mktemp)
  python3 - "$TENANT" "$document_type" "$file" "$label" >"$body" <<'PY'
import json, sys
tenant, document_type, path, label = sys.argv[1:5]
print(json.dumps({
    "tenant": tenant,
    "documentType": document_type,
    "syntaxId": "liquid",
    "content": open(path, encoding="utf-8").read(),
    "displayLabel": label,
}))
PY

  local saved
  saved=$(curl -sf "${AUTH[@]}" -X POST "$BASE/templates" \
    -H 'content-type: application/json' --data-binary @"$body")
  rm -f "$body"

  local template_id version
  template_id=$(printf '%s' "$saved" | python3 -c 'import sys,json;print(json.load(sys.stdin)["templateId"])')
  version=$(printf '%s' "$saved" | python3 -c 'import sys,json;print(json.load(sys.stdin)["version"])')

  curl -sf -o /dev/null "${AUTH[@]}" -X POST \
    "$BASE/templates/$template_id/versions/$version/publish?tenant=$TENANT"
  curl -sf -o /dev/null "${AUTH[@]}" -X POST \
    "$BASE/templates/$template_id/versions/$version/default?tenant=$TENANT"

  echo "  $document_type published as $template_id v$version"
}

echo "Provisioning examples into $BASE (tenant: $TENANT)"
ensure example-invoice template.html "Example invoice"
ensure example-invoice-footer footer.html "Example invoice footer"
echo "Done. Render with: curl -s -X POST $BASE/render -H 'content-type: application/json' --data-binary @render-request.json -o invoice.pdf"
