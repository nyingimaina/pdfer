#!/usr/bin/env python3
"""Publishes README.dockerhub.md as the Docker Hub repository overview.

Docker Hub's REST API does not accept Basic auth for this endpoint; it wants a
JWT from /v2/users/login. That login accepts the same credential `docker login`
uses (password or personal access token).

Environment:
    DOCKERHUB_USERNAME    default: nyingi
    DOCKERHUB_TOKEN       required for a real update
    DOCKERHUB_REPOSITORY  default: pdfer
"""
import json
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
USER = os.environ.get("DOCKERHUB_USERNAME", "nyingi").strip()
TOKEN = os.environ.get("DOCKERHUB_TOKEN", "").strip()
REPO = os.environ.get("DOCKERHUB_REPOSITORY", "pdfer").strip()
README = os.path.join(ROOT, "README.dockerhub.md")
SHORT = "Template + JSON in, PDF out. One container, no database."

if not TOKEN:
    print("DOCKERHUB_TOKEN is not set; skipping the Docker Hub docs update.")
    sys.exit(0)

if not os.path.exists(README):
    print(f"Missing {README}")
    sys.exit(1)

with open(README, encoding="utf-8") as handle:
    description = handle.read()


def request(url, payload=None, headers=None, method=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except urllib.error.URLError as error:
        return 0, str(error.reason)


status, body = request(
    "https://hub.docker.com/v2/users/login/",
    {"username": USER, "password": TOKEN},
)
if status == 0:
    print(f"Docker Hub is unreachable: {body}")
    sys.exit(1)
if status != 200:
    print(f"Docker Hub login failed with {status}: {body[:300]}")
    print("Use a personal access token (Account settings -> Security) with Read/Write.")
    sys.exit(1)

jwt = json.loads(body)["token"]

if "--inspect" in sys.argv:
    import base64
    payload = jwt.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    claims = json.loads(base64.urlsafe_b64decode(payload))
    for key in ("aud", "sub", "scope", "iss", "exp"):
        if key in claims:
            print(f"{key}: {claims[key]}")
    status, _ = request(
        f"https://hub.docker.com/v2/repositories/{USER}/{REPO}/",
        headers={"Authorization": f"JWT {jwt}"},
    )
    print(f"read repository: {status}")
    sys.exit(0)

status, body = request(
    f"https://hub.docker.com/v2/repositories/{USER}/{REPO}/",
    {"full_description": description, "description": SHORT},
    {"Authorization": f"JWT {jwt}"},
    method="PATCH",
)
if status == 200:
    print(f"Docker Hub overview updated for {USER}/{REPO}")
elif status == 404:
    print(f"Repository {USER}/{REPO} does not exist yet; push the image first.")
    sys.exit(1)
else:
    print(f"Docker Hub docs update failed with {status}: {body[:300]}")
    sys.exit(1)
