#!/usr/bin/env bash
# Publishes a multi-arch image, one platform at a time.
#
#   ./scripts/build-multiarch.sh [version]
#
# Building both platforms in a single buildx invocation pulls two 1.9 GB bases
# at once and can exhaust a small host; building them separately and combining
# the digests keeps the peak low. arm64 on an amd64 host needs binfmt:
#
#   docker run --privileged --rm tonistiigi/binfmt --install arm64
#
# The single-arch tags (:x.y.z-amd64 / :x.y.z-arm64) are intentionally left in
# place so a caller can pin an architecture.
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
  local platform="$1" arch="$2"
  echo "==> $platform" >&2
  docker buildx build \
    --platform "$platform" \
    --build-arg VERSION="$VERSION" \
    -t "$IMAGE:$VERSION-$arch" \
    --load \
    . >&2
  docker push "$IMAGE:$VERSION-$arch" >&2
}

build_platform linux/amd64 amd64
build_platform linux/arm64 arm64

echo "==> manifest" >&2
docker manifest create "$IMAGE:$VERSION" --amend \
  "$IMAGE:$VERSION-amd64" "$IMAGE:$VERSION-arm64" >&2
docker manifest push "$IMAGE:$VERSION" >&2
docker manifest create "$IMAGE:latest" --amend \
  "$IMAGE:$VERSION-amd64" "$IMAGE:$VERSION-arm64" >&2
docker manifest push "$IMAGE:latest" >&2

docker buildx imagetools inspect "$IMAGE:$VERSION"
echo "Published $IMAGE:$VERSION and $IMAGE:latest"
