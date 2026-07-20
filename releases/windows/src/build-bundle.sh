#!/usr/bin/env bash
# Rebuilds releases/windows/cttc-windows-deploy.zip from source, then splits
# it into <100MB releases/windows/cttc-windows-deploy.zip.partNNN chunks --
# the zip itself is well over GitHub's 100MB single-blob limit, so only the
# chunks (plus prepare-deployment.ps1, which reassembles them) get committed.
#
# The zip ships four things:
#   1. CTTC Setup.exe    - from app/dist (npm run dist:win), not rebuilt here
#   2. image/            - server image, rebuilt here (docker build + save)
#   3. deploy.ps1, README-WINDOWS.md, docker-compose.yml - this directory
#   4. keys/             - the deploy SSH keypair, NOT tracked in source
#                          control; pass its directory via -k/--keys-dir
#
# Usage:
#   releases/windows/src/build-bundle.sh --keys-dir /path/to/keys
#
# That directory must contain cttc_deploy (private) and cttc_deploy.pub,
# matching what's already authorized on the deploy target's
# ~/.ssh/authorized_keys (see README-WINDOWS.md's "Cleanup" section).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
windows_dir="$repo_root/releases/windows"
server_dir="$repo_root/app/server"

keys_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -k|--keys-dir) keys_dir="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [[ -z "$keys_dir" ]]; then
  echo "usage: $0 --keys-dir /path/to/keys (must contain cttc_deploy + cttc_deploy.pub)" >&2
  exit 1
fi
if [[ ! -f "$keys_dir/cttc_deploy" || ! -f "$keys_dir/cttc_deploy.pub" ]]; then
  echo "error: $keys_dir does not contain both cttc_deploy and cttc_deploy.pub" >&2
  exit 1
fi

installer="$(find "$repo_root/app/dist" -maxdepth 1 -name "CTTC Setup *.exe" ! -name "*.blockmap" | sort -V | tail -1)"
if [[ -z "$installer" ]]; then
  echo "error: no installer found under app/dist -- run 'npm run dist:win' in app/ first" >&2
  exit 1
fi
echo "Using installer: $installer"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

echo "Building server image (docker build, linux/amd64 -- the deploy target's arch)..."
docker build --platform linux/amd64 -t cttc-server:latest "$server_dir"

mkdir -p "$stage/image" "$stage/keys"
echo "Saving + gzipping image (this can take a minute)..."
docker save cttc-server:latest | gzip > "$stage/image/cttc-server.tar.gz"
cp "$script_dir/docker-compose.yml" "$stage/image/docker-compose.yml"

cp "$script_dir/deploy.ps1" "$stage/deploy.ps1"
cp "$script_dir/README-WINDOWS.md" "$stage/README-WINDOWS.md"
cp "$keys_dir/cttc_deploy" "$stage/keys/cttc_deploy"
cp "$keys_dir/cttc_deploy.pub" "$stage/keys/cttc_deploy.pub"
chmod 600 "$stage/keys/cttc_deploy"
cp "$installer" "$stage/CTTC Setup.exe"

out="$windows_dir/cttc-windows-deploy.zip"
rm -f "$out" "$windows_dir"/cttc-windows-deploy.zip.part*
( cd "$stage" && zip -qr "$out" . )
echo "Wrote $out ($(du -h "$out" | cut -f1))"

echo "Splitting into <100MB chunks for git..."
( cd "$windows_dir" && split -b 45m -d -a 3 cttc-windows-deploy.zip cttc-windows-deploy.zip.part )
rm -f "$out"
ls "$windows_dir"/cttc-windows-deploy.zip.part* | xargs -n1 basename

echo ""
echo "Chunks are in $windows_dir -- commit cttc-windows-deploy.zip.part* (not the"
echo "zip itself, which is gitignored). Reassemble with prepare-deployment.ps1."
docker rmi cttc-server:latest > /dev/null 2>&1 || true
