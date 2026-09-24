#!/bin/bash
# Exercise the packaged access service with synthetic state and a Docker test double.
# No host Docker socket, published port, cloud access, or customer data is used.
set -euo pipefail
image=${1:?Pass the locally built runtime image}
docker run --rm -i --network none --entrypoint bash "$image" <<'CONTAINER'
set -euo pipefail
mkdir -p /opt/sac /var/lib/sac/{state,auth,exports,locks} /tmp/test-bin
age-keygen -o /tmp/test-identity >/dev/null 2>&1
recipient=$(age-keygen -y /tmp/test-identity)
node - "$recipient" <<'CONFIG'
const fs=require('node:fs');
fs.writeFileSync('/opt/sac/tenant.json',JSON.stringify({tenantId:'fixture',hostname:'tenant.test',managementKey:'fixture-management',backupRecipient:process.argv[2],openclawImage:'fixture-image'}));
fs.writeFileSync('/opt/sac/openclaw.env','TEST_ONLY=true\n');
fs.writeFileSync('/var/lib/sac/state/test.txt','synthetic backup state');
CONFIG
cat >/tmp/test-bin/docker <<'DOCKER'
#!/bin/bash
set -euo pipefail
case "$1" in
 inspect) cat /tmp/gateway-running ;;
 stop) echo stop >>/tmp/docker-events; echo false >/tmp/gateway-running; sleep 1 ;;
 start) echo start >>/tmp/docker-events; echo true >/tmp/gateway-running ;;
 *) echo 'Unexpected Docker operation' >&2; exit 1 ;;
esac
DOCKER
chmod +x /tmp/test-bin/docker
export PATH="/tmp/test-bin:$PATH"
echo true >/tmp/gateway-running
node dist/tenant/main.js >/tmp/access-log 2>&1 &
service_pid=$!
trap 'kill "$service_pid" 2>/dev/null || true' EXIT
node --input-type=module <<'VERIFY'
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const base='http://127.0.0.1:3080';
let started=false;
for(let i=0;i<100;i++){
 try {await fetch(base+'/handoff');started=true;break;} catch {await delay(50);}
}
assert.ok(started, 'access service starts');
const db=new DatabaseSync('/var/lib/sac/access.sqlite');
const hash=x=>createHash('sha256').update(x).digest('hex');
for(const action of ['access','export']) db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(hash(action),Date.now(),Date.now()+60000,action,'');
const access={cookie:'agent_session=access'};
// Caddy invokes this for every asset: more than 60 checks must not throttle the page.
for(let i=0;i<75;i++) assert.equal((await fetch(base+'/authorize',{headers:access})).status,204);
assert.equal((await fetch(base+'/internal/suspend',{method:'POST'})).status,401);
const management={authorization:'Bearer fixture-management'};
const backup=fetch(base+'/internal/backup',{method:'POST',headers:management});
let exporting=false;
for(let i=0;i<100;i++){
 if(existsSync('/tmp/docker-events') && readFileSync('/tmp/docker-events','utf8').includes('stop')) {exporting=true;break;}
 await delay(25);
}
assert.ok(exporting,'backup reached its quiesced snapshot while holding the lock');
const suspend=fetch(base+'/internal/suspend',{method:'POST',headers:management});
const archive=await backup;
assert.equal(archive.status,200);
assert.ok((await archive.arrayBuffer()).byteLength>0);
assert.equal((await suspend).status,200);
assert.equal(readFileSync('/tmp/gateway-running','utf8').trim(),'false');
assert.deepEqual(readFileSync('/tmp/docker-events','utf8').trim().split('\n'),['stop','start','stop']);
assert.equal((await fetch(base+'/api/local/info',{headers:access})).status,403);
assert.equal((await fetch(base+'/authorize',{headers:access})).status,403);
assert.equal((await fetch(base+'/api/local/info',{headers:{cookie:'agent_session=export'}})).status,200);
assert.equal((await fetch(base+'/internal/resume',{method:'POST',headers:management})).status,200);
assert.equal((await fetch(base+'/authorize',{headers:access})).status,204);
db.close();
console.log('Packaged tenant smoke passed: auth fan-out, backup/suspend serialization, suspended access, export access, resume.');
VERIFY
CONTAINER
