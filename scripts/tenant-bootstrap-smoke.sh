#!/bin/bash
# Render production bootstrap files and validate the actual Caddy configuration.
set -euo pipefail
image=${1:?Pass the locally built runtime image}
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture"/{etc/caddy,etc/systemd/system,etc/sysctl.d,etc/ssh/sshd_config.d,usr/local/bin}
cat >"$fixture/bundle.json" <<'JSON'
{"tenantId":"bootstrap-fixture","hostname":"tenant.test","adminCidr":"203.0.113.1/32","controlOrigin":"https://control.test","gatewayToken":"fixture-token","managementKey":"fixture-management","publicKey":"fixture-public-key","mode":"byok","openclawImage":"fixture-openclaw","tenantImage":"fixture-access","backupRecipient":"fixture-recipient"}
JSON
docker run --rm --network none -v "$fixture:/host" --entrypoint sh "$image" -c '
  node dist/tenant/bootstrap.js /host/bundle.json
  result=$?
  chmod -R a+rwX /host
  exit "$result"
' 
bash -n "$fixture/opt/sac/firewall.sh" "$fixture/usr/local/bin/sac-onboard"
docker run --rm --network none -v "$fixture/etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile
printf '%s\n' 'Production bootstrap renders valid Caddy and shell configuration.'
