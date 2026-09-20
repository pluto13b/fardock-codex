#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: init-gateway-host.sh <deployment-root> <gateway-image>" >&2
  exit 2
fi

deployment_root=$1
gateway_image=$2

case "$deployment_root" in
  /*) ;;
  *) echo "deployment root must be absolute" >&2; exit 2 ;;
esac

deployment_root=$(readlink -f -- "$deployment_root")
if [ -z "$deployment_root" ] || [ "$deployment_root" = / ] || [ -d "$deployment_root/.git" ] || [ ! -f "$deployment_root/compose.yaml" ]; then
  echo "deployment root is unsafe or incomplete" >&2
  exit 2
fi

for target in "$deployment_root/data" "$deployment_root/secrets"; do
  if [ -L "$target" ]; then
    echo "deployment path cannot be a symlink" >&2
    exit 2
  fi
done
if [ -e "$deployment_root/secrets/relay-bootstrap" ] && [ -L "$deployment_root/secrets/relay-bootstrap" ]; then
  echo "bootstrap file cannot be a symlink" >&2
  exit 2
fi
if [ ! -f "$deployment_root/secrets/owner-verifier.json" ] || [ -L "$deployment_root/secrets/owner-verifier.json" ]; then
  echo "owner verifier file is missing or unsafe" >&2
  exit 2
fi

mkdir -p -- "$deployment_root/data" "$deployment_root/secrets"

docker run --rm \
  --user 0:0 \
  --volume "$deployment_root/data:/host-data" \
  --volume "$deployment_root/secrets:/host-secrets" \
  --entrypoint /bin/sh \
  "$gateway_image" -eu -c '
    chown 10001:10001 /host-data
    chmod 0700 /host-data
    chown 0:10001 /host-secrets
    chmod 0750 /host-secrets
    if [ -e /host-secrets/relay-bootstrap ]; then
      test -f /host-secrets/relay-bootstrap
      test ! -L /host-secrets/relay-bootstrap
      chown 0:10001 /host-secrets/relay-bootstrap
      chmod 0440 /host-secrets/relay-bootstrap
    fi
    test -f /host-secrets/owner-verifier.json
    test ! -L /host-secrets/owner-verifier.json
    chown 0:10001 /host-secrets/owner-verifier.json
    chmod 0440 /host-secrets/owner-verifier.json
  '

docker run --rm \
  --user 10001:10001 \
  --read-only \
  --tmpfs /tmp:size=1m,mode=1770,noexec,nosuid,nodev,uid=10001,gid=10001 \
  --volume "$deployment_root/data:/var/lib/codex-plus" \
  --entrypoint node \
  "$gateway_image" -e '
    const fs = require("node:fs");
    const base = "/var/lib/codex-plus";
    const first = `${base}/.permission-probe-${process.pid}`;
    const second = `${first}.renamed`;
    const handle = fs.openSync(first, "wx", 0o600);
    fs.writeSync(handle, "ok");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    fs.renameSync(first, second);
    if (fs.readFileSync(second, "utf8") !== "ok") process.exit(1);
    fs.unlinkSync(second);
  '

if [ -e "$deployment_root/secrets/relay-bootstrap" ]; then
  docker run --rm \
    --user 10001:10001 \
    --read-only \
    --volume "$deployment_root/secrets/relay-bootstrap:/run/secrets/relay-bootstrap:ro" \
    --entrypoint /bin/sh \
    "$gateway_image" -eu -c '
      test -r /run/secrets/relay-bootstrap
      test "$(stat -c %a /run/secrets/relay-bootstrap)" = 440
    '
fi

docker run --rm \
  --user 10001:10001 \
  --read-only \
  --volume "$deployment_root/secrets/owner-verifier.json:/run/secrets/codex-plus-owner-verifier:ro" \
  --entrypoint /bin/sh \
  "$gateway_image" -eu -c '
    test -r /run/secrets/codex-plus-owner-verifier
    test "$(stat -c %a /run/secrets/codex-plus-owner-verifier)" = 440
  '

echo "gateway host permissions verified"
