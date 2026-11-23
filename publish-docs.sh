#!/bin/sh
# Thin wrapper so existing callers (release.sh, the release workflow) keep working.
set -eu
exec python3 "$(dirname "$0")/publish-docs.py" "$@"
