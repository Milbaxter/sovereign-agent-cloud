#!/bin/bash
set -euo pipefail
umask 077
# BOOTSTRAP_VARIABLES
# No shell tracing: bootstrap tokens must never appear in cloud-init logs.
install -d -m 700 /opt/sac /var/lib/sac
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 caddy ttyd age jq nftables
printf '{"token":"%s"}' "$BOOTSTRAP_TOKEN" >/opt/sac/bootstrap-request.json
# An authenticated early request must not consume its token before the worker
# verifies encryption and DNS. Retry only the explicit readiness response.
bootstrap_status=000
for attempt in $(seq 1 120); do
  bootstrap_status=$(curl --silent --show-error --max-time 60 -w '%{http_code}' -o /opt/sac/bundle.json -H 'Content-Type: application/json' --data-binary @/opt/sac/bootstrap-request.json "$CONTROL_ORIGIN/bootstrap/$TENANT_ID")
  if [ "$bootstrap_status" = 200 ]; then break; fi
  if [ "$bootstrap_status" != 503 ] || ! jq -e '.error == "BOOTSTRAP_NOT_READY"' /opt/sac/bundle.json >/dev/null; then
    echo "Bootstrap rejected (HTTP $bootstrap_status)" >&2
    exit 1
  fi
  sleep 5
done
test "$bootstrap_status" = 200
rm -f /opt/sac/bootstrap-request.json
unset BOOTSTRAP_TOKEN
image=$(jq -r .tenantImage /opt/sac/bundle.json)
docker pull "$image"
docker run --rm --network none -v /:/host "$image" node dist/tenant/bootstrap.js /host/opt/sac/bundle.json
# Install metadata/private-network egress rules before starting tenant workloads.
systemctl daemon-reload
systemctl enable --now sac-firewall.service
docker compose --env-file /opt/sac/openclaw.env -f /opt/sac/compose.yml up -d
docker exec sac-access /app/deploy/configure-browser.sh
sysctl --system >/dev/null
systemctl daemon-reload
systemctl enable --now sac-terminal.service
systemctl reload ssh
systemctl restart caddy
touch /var/lib/sac/bootstrap-complete
# Cloud-init's original userdata contains an expired single-use token only.
rm -f /opt/sac/bundle.json
