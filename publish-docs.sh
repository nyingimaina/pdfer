#!/bin/sh
# Publishes pdfer/README.dockerhub.md as the Docker Hub repository overview.
#
#   DOCKERHUB_USERNAME=nyingi DOCKERHUB_TOKEN=<read/write PAT> sh publish-docs.sh
#
# Skips quietly when no token is configured, so it is safe to call from CI.
set -eu

[ -z "${DOCKERHUB_TOKEN:-}" ] && {
  echo "DOCKERHUB_TOKEN is not set; skipping the Docker Hub docs update."
  exit 0
}

USER_NAME="${DOCKERHUB_USERNAME:-nyingi}"
REPO="${DOCKERHUB_REPOSITORY:-pdfer}"
README="README.dockerhub.md"

[ -f "$README" ] || {
  echo "Missing $README"
  exit 1
}

if command -v python3 >/dev/null 2>&1; then
  BODY=$(python3 -c 'import json,sys; print(json.dumps({"full_description": open(sys.argv[1], encoding="utf-8").read()}))' "$README")
elif command -v jq >/dev/null 2>&1; then
  BODY=$(jq -Rs '{full_description: .}' "$README")
else
  echo "Neither python3 nor jq is available; skipping the Docker Hub docs update."
  exit 0
fi

STATUS=$(curl -sS -o /tmp/dockerhub-docs.out -w '%{http_code}' \
  -u "$USER_NAME:$DOCKERHUB_TOKEN" \
  -X PATCH "https://hub.docker.com/v2/repositories/$USER_NAME/$REPO/" \
  -H 'content-type: application/json' \
  --data-binary "$BODY")

case "$STATUS" in
  200) echo "Docker Hub overview updated for $USER_NAME/$REPO" ;;
  404) echo "Repository $USER_NAME/$REPO does not exist yet (push the image first)." ;;
  *)   echo "Docker Hub docs update failed with $STATUS:"; cat /tmp/dockerhub-docs.out ;;
esac
