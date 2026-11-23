#!/usr/bin/env bash
# Builds and publishes a multi-arch image, one platform at a time.
#
#   ./scripts/build-multiarch.sh [version]
#
# One platform per build keeps the peak memory low (each base is ~1.9 GB);
# the two digests are then combined into one manifest list. Requires binfmt
# for arm64 on an amd64 host:
#
#   docker run --privileged --rm tonistiigi/binfmt --install arm64
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-$(cat version.txt)}"
IMAGE="${PDFER_IMAGE:-nyingi/pdfer}"
BUILDER="${PDFER_BUILDER:-pdfer-builder}"

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER" --driver docker-container
fi
docker buildx use "$BUILDER" >/dev/null

build_platform() {
  local platform="$1" metadata="$2"
  echo "==> $platform" >&2
  docker buildx build \
    --platform "$platform" \
    --build-arg VERSION="$VERSION" \
    --output "type=image,name=$IMAGE,push-by-digest=true,name-canonical=true,push=true" \
    --metadata-file "$metadata" \
    . >&2
  python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['containerimage.digest'])" "$metadata"
}

ARM=$(build_platform linux/arm64 /tmp/pdfer-arm.json)
AMD=$(build_platform linux/amd64 /tmp/pdfer-amd.json)

echo "==> manifest"
docker buildx imagetools create \
  -t "$IMAGE:$VERSION" \
  -t "$IMAGE:latest" \
  "$IMAGE@$ARM" \
  "$IMAGE@$AMD"

docker buildx imagetools inspect "$IMAGE:$VERSION"
echo "Published $IMAGE:$VERSION and $IMAGE:latest"
