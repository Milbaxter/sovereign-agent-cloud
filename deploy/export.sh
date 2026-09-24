#!/bin/bash
set -euo pipefail
umask 077
recipient=$1
output=$2
work=$(mktemp -d /var/lib/sac/exports/staging.XXXXXX)
was_running=$(docker inspect -f '{{.State.Running}}' openclaw)
cleanup() { rm -rf "$work"; if [ "$was_running" = true ]; then docker start openclaw >/dev/null; fi; }
trap cleanup EXIT
if [ "$was_running" = true ]; then docker stop openclaw >/dev/null; fi
# Entire quiesced state, encrypted auth store, provider env, and a portable manifest.
cp -a /var/lib/sac/state "$work/state"
cp -a /var/lib/sac/auth "$work/auth"
cp /opt/sac/openclaw.env "$work/openclaw.env"
node -e 'const fs=require("fs");const b=JSON.parse(fs.readFileSync("/opt/sac/tenant.json"));fs.writeFileSync(process.argv[1],JSON.stringify({format:1,image:b.openclawImage,state:"state",auth:"auth",environment:"openclaw.env",originalHostname:b.hostname},null,2))' "$work/manifest.json"
cp /app/docs/RESTORE.md "$work/RESTORE.md"
(cd "$work" && find state auth -type f -print0 | sort -z | xargs -0 -r sha256sum > SHA256SUMS && sha256sum openclaw.env manifest.json RESTORE.md >> SHA256SUMS && sha256sum -c SHA256SUMS >/dev/null)
tar -C "$work" -cf - . | age -r "$recipient" -o "$output"
test -s "$output"
