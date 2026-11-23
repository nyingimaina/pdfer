#!/usr/bin/env bash
# Builds and publishes the image, then refreshes the Docker Hub overview.
#
#   ./release.sh              # uses version.txt
#   ./release.sh 1.2.0        # explicit version
#
# Requires a `docker login` for the target namespace. The docs step needs
# DOCKERHUB_USERNAME and DOCKERHUB_TOKEN; it is skipped when they are absent.
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${1:-$(cat version.txt)}"
IMAGE="${PDFER_IMAGE:-nyingi/pdfer}"

echo "==> tests"
npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || true
node --test test/*.test.js
node conformance/run.js

echo "==> build $IMAGE:$VERSION"
docker build --build-arg VERSION="$VERSION" -t "$IMAGE:$VERSION" -t "$IMAGE:latest" .

echo "==> push"
docker push "$IMAGE:$VERSION"
docker push "$IMAGE:latest"

echo "==> Docker Hub overview"
DOCKERHUB_REPOSITORY="${IMAGE#*/}" sh publish-docs.sh || true

echo "Released $IMAGE:$VERSION"
