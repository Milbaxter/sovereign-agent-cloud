#!/bin/bash
set -euo pipefail
umask 077
# BOOTSTRAP_VARIABLES
# No shell tracing: bootstrap tokens must never appear in cloud-init logs.
install -d -m 700 /opt/sac /var/lib/sac
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 caddy ttyd age jq nftables
printf '{"token":"%s"}' "$BOOTSTRAP_TOKEN" >/opt/sac/bootstrap-request.json
curl --fail --silent --show-error --max-time 60 -H 'Content-Type: application/json' --data-binary @/opt/sac/bootstrap-request.json "$CONTROL_ORIGIN/bootstrap/$TENANT_ID" >/opt/sac/bundle.json
rm -f /opt/sac/bootstrap-request.json
unset BOOTSTRAP_TOKEN
image=$(jq -r .tenantImage /opt/sac/bundle.json)
docker pull "$image"
docker run --rm --network none -v /:/host "$image" node dist/tenant/bootstrap.js /host/opt/sac/bundle.json
docker compose --env-file /opt/sac/openclaw.env -f /opt/sac/compose.yml up -d
docker exec sac-access /app/deploy/configure-browser.sh
sysctl --system >/dev/null
systemctl daemon-reload
systemctl enable --now sac-firewall.service sac-terminal.service
systemctl reload ssh
systemctl restart caddy
touch /var/lib/sac/bootstrap-complete
# Cloud-init's original userdata contains an expired single-use token only.
rm -f /opt/sac/bundle.json
