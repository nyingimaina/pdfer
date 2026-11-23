#!/bin/sh
# Publishes README.dockerhub.md using the credential that `docker login`
# already stored for Docker Hub. Never prints the secret.
#
#   sh scripts/publish-docs-using-docker-login.sh
set -eu
cd "$(dirname "$0")/.."

CRED=$(mktemp)
trap 'rm -f "$CRED"' EXIT
chmod 600 "$CRED"

python3 - "$CRED" <<'PY'
import base64, json, os, sys
path = os.path.expanduser('~/.docker/config.json')
config = json.load(open(path))
key = 'https://index.docker.io/v1/'
if key not in config.get('auths', {}):
    sys.exit('No Docker Hub credential in ~/.docker/config.json; run docker login first.')
user, _, token = base64.b64decode(config['auths'][key]['auth']).decode().partition(':')
with open(sys.argv[1], 'w', encoding='utf-8') as handle:
    handle.write(user + '\n' + token + '\n')
PY

USER_NAME=$(sed -n 1p "$CRED")
TOKEN=$(sed -n 2p "$CRED")
[ -n "$USER_NAME" ] && [ -n "$TOKEN" ] || { echo "Could not read the stored credential."; exit 1; }

echo "Publishing the overview as '$USER_NAME' (token length ${#TOKEN})"
DOCKERHUB_USERNAME="$USER_NAME" DOCKERHUB_TOKEN="$TOKEN" sh publish-docs.sh "$@"
