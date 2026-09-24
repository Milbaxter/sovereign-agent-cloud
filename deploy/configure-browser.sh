#!/bin/bash
set -euo pipefail
container=${OPENCLAW_CONTAINER:-openclaw}
# Resolve the bundled executable from the pinned image on either CPU architecture.
executable=$(docker exec "$container" node -e '
const fs=require("fs"),base="/home/node/.cache/ms-playwright";
for(const revision of fs.readdirSync(base).filter(x=>/^chromium-[0-9]+$/.test(x)).sort().reverse()) {
 for(const platform of fs.readdirSync(base+"/"+revision).filter(x=>x.startsWith("chrome-linux"))) {
  const p=base+"/"+revision+"/"+platform+"/chrome";if(fs.existsSync(p)){console.log(p);process.exit(0);}
 }
}
process.exit(1);')
docker exec "$container" node dist/index.js config set browser.executablePath "$executable" >/dev/null
docker exec "$container" node dist/index.js config set browser.headless true --strict-json >/dev/null
# Chromium's setuid sandbox cannot run under the unprivileged/no-new-privileges container.
# The dedicated VM and unprivileged container remain the isolation boundary.
docker exec "$container" node dist/index.js config set browser.noSandbox true --strict-json >/dev/null
docker restart "$container" >/dev/null
