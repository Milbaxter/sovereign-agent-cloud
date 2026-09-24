#!/bin/bash
# Reproducible local-only export/restore test; all names/volumes belong to this run.
set -euo pipefail
image='ghcr.io/openclaw/openclaw:2026.9.6-browser@sha256:62832668e3e5e139f745f7d3df892c9251eb53318b7d14a76c410dde1f25d730'
runtime=${SAC_RUNTIME_IMAGE:-sovereign-agent-cloud:local}
prefix="sac-runtime-test-$$"
cleanup() {
 docker rm -f "$prefix-agent" "$prefix-tools" "$prefix-restored" >/dev/null 2>&1 || true
 for v in state data config restore; do docker volume rm "$prefix-$v" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT
for v in state data config restore; do docker volume create "$prefix-$v" >/dev/null; done
docker run --rm --entrypoint node -u 0 -v "$prefix-state:/state" "$image" -e '
 const fs=require("fs");fs.mkdirSync("/state/workspace",{recursive:true});
 fs.writeFileSync("/state/workspace/MEMORY.md","portable synthetic memory fixture\n");
 fs.writeFileSync("/state/openclaw.json",JSON.stringify({gateway:{mode:"local",bind:"lan",auth:{mode:"token",token:"synthetic-fixture-token"},controlUi:{allowedOrigins:["http://localhost"]}},agents:{defaults:{workspace:"/home/node/.openclaw/workspace"}}}));
 for(const p of ["/state","/state/workspace","/state/workspace/MEMORY.md","/state/openclaw.json"])fs.chownSync(p,1000,1000);'
docker run -d --name "$prefix-agent" --init --cap-drop ALL --security-opt no-new-privileges:true -e OPENCLAW_GATEWAY_TOKEN=synthetic-fixture-token -v "$prefix-state:/home/node/.openclaw" "$image" node dist/index.js gateway --bind lan --allow-unconfigured >/dev/null
ready=false
for i in $(seq 1 30); do if docker exec "$prefix-agent" node dist/index.js health >/dev/null 2>&1; then ready=true; break; fi; sleep 2; done
[ "$ready" = true ]
docker run -d --name "$prefix-tools" -e OPENCLAW_CONTAINER="$prefix-agent" -e SMOKE_OPENCLAW_IMAGE="$image" -v /var/run/docker.sock:/var/run/docker.sock -v "$prefix-data:/var/lib/sac" -v "$prefix-state:/var/lib/sac/state" -v "$prefix-config:/opt/sac" -v "$prefix-restore:/restored" "$runtime" sleep infinity >/dev/null
docker exec "$prefix-tools" bash -c '
 set -euo pipefail
 umask 077
 mkdir -p /var/lib/sac/auth /var/lib/sac/exports /var/lib/sac/locks
 node -e '\''require("fs").writeFileSync("/opt/sac/tenant.json",JSON.stringify({openclawImage:process.env.SMOKE_OPENCLAW_IMAGE,hostname:"old.example.com"}))'\''
 printf "OPENCLAW_GATEWAY_TOKEN=synthetic-fixture-token\n" >/opt/sac/openclaw.env
 age-keygen -o /var/lib/sac/exports/identity.txt 2>/dev/null
 recipient=$(age-keygen -y /var/lib/sac/exports/identity.txt)
 /app/deploy/export.sh "$recipient" /var/lib/sac/exports/test.tar.age
 age -d -i /var/lib/sac/exports/identity.txt /var/lib/sac/exports/test.tar.age | tar -xf - -C /restored
 cd /restored
 sha256sum -c SHA256SUMS >/dev/null
 test "$(cat state/workspace/MEMORY.md)" = "portable synthetic memory fixture"
 chown 1000:1000 /restored
 chown -R 1000:1000 state auth
 echo "Encrypted export decrypts and all checksums match; synthetic memory preserved."
'
# Original stops before activating restored channel/state; synthetic fixture has no real channels.
docker stop "$prefix-agent" >/dev/null
docker run -d --name "$prefix-restored" --init --cap-drop ALL -e OPENCLAW_GATEWAY_TOKEN=synthetic-fixture-token -v "$prefix-restore:/restore" -e OPENCLAW_STATE_DIR=/restore/state "$image" node dist/index.js gateway --bind lan --allow-unconfigured >/dev/null
ready=false
for i in $(seq 1 30); do if docker exec "$prefix-restored" node dist/index.js health >/dev/null 2>&1; then ready=true;break;fi;sleep 2;done
[ "$ready" = true ]
echo 'Pinned OpenClaw starts successfully from the independently restored state.'
