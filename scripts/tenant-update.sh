#!/bin/bash
# Run as root on a tenant VM. Snapshot before changing the upstream image.
set -euo pipefail
umask 077
image=${1:?Pass an official OpenClaw version tag plus sha256 digest}
[[ "$image" =~ ^ghcr.io/openclaw/openclaw:[a-zA-Z0-9._-]+@sha256:[a-f0-9]{64}$ ]] || exit 2
exec 9>/var/lib/sac/locks/operation
flock -w 120 9
docker pull "$image"
backup=$(mktemp -d /var/lib/sac/pre-upgrade.XXXXXX)
docker stop openclaw >/dev/null
cp -a /var/lib/sac/state /var/lib/sac/auth /opt/sac/compose.yml /opt/sac/tenant.json "$backup/"
rollback() {
 docker stop openclaw >/dev/null || true
 rm -rf /var/lib/sac/state /var/lib/sac/auth
 cp -a "$backup/state" "$backup/auth" /var/lib/sac/
 cp "$backup/compose.yml" /opt/sac/compose.yml
 cp "$backup/tenant.json" /opt/sac/tenant.json
 docker compose --env-file /opt/sac/openclaw.env -f /opt/sac/compose.yml up -d
 echo 'Upgrade failed; restored previous image and state.' >&2
}
trap rollback ERR
python3 - "$image" <<'PY'
import json,sys,re
p='/opt/sac/compose.yml'
s=open(p).read();s=re.sub(r'image: ghcr.io/openclaw/openclaw:[^\n]+','image: '+sys.argv[1],s);open(p,'w').write(s)
p='/opt/sac/tenant.json'; b=json.load(open(p));b['openclawImage']=sys.argv[1];open(p,'w').write(json.dumps(b))
PY
docker compose --env-file /opt/sac/openclaw.env -f /opt/sac/compose.yml up -d --force-recreate
for i in $(seq 1 30); do
 if docker exec openclaw node dist/index.js health >/dev/null 2>&1; then
  trap - ERR
  echo "Upgrade healthy. Previous consistent state retained at $backup; remove after validation."
  exit 0
 fi
 sleep 2
done
false
