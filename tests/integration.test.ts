import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import Stripe from "stripe";
import { database, transaction } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import {
  credit,
  reverseCredit,
  reserve,
  settle,
  price,
  quarantineStaleUsage,
} from "../src/ledger.js";
import { hash, token, seal, unseal, handoff } from "../src/crypto.js";
import { Billing } from "../src/billing.js";
import { buildApp } from "../src/app.js";
import { Provisioner } from "../src/provision.js";
import { UpCloud } from "../src/providers/upcloud.js";
import { consumeTicket } from "../src/tenant/tickets.js";
import { UsageStream } from "../src/inference.js";
import { launchGate, type Config, type Model } from "../src/config.js";
const testUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:sac-local-test-only@127.0.0.1:55432/sac_test";
if (!new URL(testUrl).pathname.endsWith("_test"))
  throw Error("Tests require a disposable database whose name ends in _test");
const db = database(testUrl);
const pair = generateKeyPairSync("ed25519");
const c = {
  PUBLIC_ORIGIN: "https://portal.test",
  TENANT_DOMAIN: "agents.test",
  NODE_ENV: "test",
  BILLING_MODE: "test",
  CHECKOUT_ENABLED: false,
  CREDITS_ENABLED: false,
  MAX_TENANTS: 50,
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_testing",
  STRIPE_HOSTING_PRICE_ID: "price_host",
  STRIPE_CREDIT_PRICE_ID: "price_credit",
  ENCRYPTION_KEY: Buffer.alloc(32, 42).toString("base64"),
  privateKey: String(pair.privateKey.export({ type: "pkcs8", format: "pem" })),
  publicKey: String(pair.publicKey.export({ type: "spki", format: "pem" })),
  OPENCLAW_IMAGE:
    "ghcr.io/openclaw/openclaw:2026.9.6-browser@sha256:" + "a".repeat(64),
  TENANT_IMAGE:
    "ghcr.io/milbaxter/sovereign-agent-cloud:test@sha256:" + "b".repeat(64),
  UPCLOUD_PLAN: "test",
  UPCLOUD_TOKEN: "test-token",
  UPCLOUD_TEMPLATE: "test",
  ADMIN_CIDR: "203.0.113.1/32",
  ADMIN_SSH_PUBLIC_KEY: "ssh-ed25519 TEST",
  BACKUP_AGE_RECIPIENT: "",
  MODEL_CONFIG_FILE: "models.json",
} as Config;
const model: Model = {
  id: "test",
  label: "Test",
  provider: "test",
  country: "France",
  baseUrl: "https://provider.test/v1",
  keyEnv: "TEST_INFERENCE_KEY",
  upstreamModel: "upstream",
  rateVersion: "test-v1",
  inputMicroEurPerMillion: 1000000n,
  cachedMicroEurPerMillion: 100000n,
  outputMicroEurPerMillion: 1000000n,
  maxContext: 1000,
  maxOutput: 1000,
  verified: true,
};
let account: string, tenant: string;
before(async () => {
  await db.query("SELECT 1");
});
beforeEach(async () => {
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await migrate(db);
  account = randomUUID();
  tenant = randomUUID();
  await db.query(
    "INSERT INTO accounts(id,email,stripe_customer) VALUES($1,$2,$3)",
    [account, `${account}@test.example`, "cus_test"],
  );
  await db.query(
    "INSERT INTO tenants(id,account_id,mode,model_id,state,hostname,management_cipher,paid_until) VALUES($1,$2,'credits','test','ready',$3,$4,now()+interval '30 days')",
    [
      tenant,
      account,
      `${tenant}.agents.test`,
      seal("secret", c.ENCRYPTION_KEY),
    ],
  );
});
after(async () => db.end());
test("encrypted secrets authenticate ciphertext and key", () => {
  const ciphertext = seal("secret", c.ENCRYPTION_KEY);
  assert.equal(unseal(ciphertext, c.ENCRYPTION_KEY), "secret");
  assert.throws(() => unseal(ciphertext, Buffer.alloc(32).toString("base64")));
});
test("25% rates charge cached tokens once and round upward", () => {
  assert.equal(price(model, 1000, 1000, 500), 1938n);
  assert.throws(() => price(model, 1, 1, 2));
});
test("duplicate credits are applied exactly once", async () => {
  await Promise.all(
    Array.from({ length: 10 }, () =>
      transaction(db, (tx) => credit(tx, account, "same-payment", 10_000_000n)),
    ),
  );
  assert.equal(
    (await db.query("SELECT balance FROM wallets")).rows[0].balance,
    "10000000",
  );
  assert.equal((await db.query("SELECT * FROM ledger")).rowCount, 1);
});
test("concurrent reservations cannot overspend", async () => {
  await transaction(db, (tx) => credit(tx, account, "topup", 10000n));
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => reserve(db, account, tenant, model, 1000)),
  );
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 4);
  assert.equal(
    (await db.query("SELECT reserved FROM wallets")).rows[0].reserved,
    "10000",
  );
});
test("settlement is idempotent and releases unused reserve", async () => {
  await transaction(db, (tx) => credit(tx, account, "topup", 10000n));
  const id = await reserve(db, account, tenant, model, 1000);
  await Promise.all([
    settle(db, id, model, { prompt_tokens: 100, completion_tokens: 100 }),
    settle(db, id, model, { prompt_tokens: 100, completion_tokens: 100 }),
  ]);
  const w = (await db.query("SELECT * FROM wallets")).rows[0];
  assert.equal(w.balance, "9750");
  assert.equal(w.reserved, "0");
});
test("unknown usage holds funds beyond 24 hours and blocks reuse until reconciled", async () => {
  await transaction(db, (tx) => credit(tx, account, "topup", 10000n));
  const id = await reserve(db, account, tenant, model, 1000);
  await settle(db, id, model, null);
  assert.equal(
    (await db.query("SELECT state FROM requests")).rows[0].state,
    "unknown",
  );
  await db.query("UPDATE requests SET created_at=now()-interval '25 hours'");
  await quarantineStaleUsage(db);
  await quarantineStaleUsage(db);
  const w = (await db.query("SELECT * FROM wallets")).rows[0];
  assert.equal(w.balance, "10000");
  assert.equal(w.reserved, "2500");
  assert.equal(
    (await db.query("SELECT state FROM requests")).rows[0].state,
    "unknown",
  );
  await assert.rejects(
    reserve(db, account, tenant, model, 1000),
    /USAGE_RECONCILIATION_REQUIRED/,
  );
  await transaction(db, (tx) => credit(tx, account, "extra-topup", 10000n));
  await assert.rejects(
    reserve(db, account, tenant, model, 1000),
    /USAGE_RECONCILIATION_REQUIRED/,
  );
  await settle(
    db,
    id,
    {
      ...model,
      rateVersion: "new-version",
      outputMicroEurPerMillion: 999999999n,
    },
    { prompt_tokens: 100, completion_tokens: 100 },
    "provider-record-123",
  );
  const reconciled = (await db.query("SELECT * FROM wallets")).rows[0];
  assert.equal(reconciled.balance, "19750");
  assert.equal(reconciled.reserved, "0");
  assert.equal(
    (await db.query("SELECT metadata FROM ledger WHERE kind='usage'")).rows[0]
      .metadata.reconciliationEvidence,
    "provider-record-123",
  );
  await reserve(db, account, tenant, model, 1000);
});
test("refund during a request records debt without negative balances", async () => {
  const order = randomUUID();
  await db.query(
    "INSERT INTO orders(id,account_id,tenant_id,kind,mode,amount_cents) VALUES($1,$2,$3,'credits','test',1000)",
    [order, account, tenant],
  );
  await transaction(db, (tx) => credit(tx, account, "topup", 10000n));
  const id = await reserve(db, account, tenant, model, 1000);
  await transaction(db, (tx) => reverseCredit(tx, account, order, 10000n));
  await settle(db, id, model, { prompt_tokens: 100, completion_tokens: 100 });
  const w = (await db.query("SELECT * FROM wallets")).rows[0];
  assert.equal(w.balance, "0");
  assert.equal(w.debt, "250");
  await assert.rejects(
    reserve(db, account, tenant, model, 1000),
    /INSUFFICIENT/,
  );
});
test("repeated reversal and won dispute restore only the correct balance", async () => {
  const order = randomUUID();
  await db.query(
    "INSERT INTO orders(id,account_id,kind,mode,amount_cents) VALUES($1,$2,'credits','test',1000)",
    [order, account],
  );
  await transaction(db, (tx) => credit(tx, account, "topup", 10000n));
  await transaction(db, (tx) => reverseCredit(tx, account, order, 10000n));
  await transaction(db, (tx) => reverseCredit(tx, account, order, 10000n));
  await transaction(db, (tx) => reverseCredit(tx, account, order, 1000n));
  assert.equal(
    (await db.query("SELECT balance FROM wallets")).rows[0].balance,
    "9000",
  );
});
test("stream parser handles split usage events and excludes completion text", () => {
  const s = new UsageStream();
  s.push(
    'data: {"choices":[{"delta":{"content":"private text"}}]}\n\ndata: {"us',
  );
  s.push('age":{"prompt_tokens":10,"completion_tokens":20}}\n\ndata: [DONE]\n');
  assert.deepEqual(s.usage, { prompt_tokens: 10, completion_tokens: 20 });
  assert.equal(s.buffer, "");
});
test("signed webhooks persist one durable job before acknowledgement", async () => {
  const billing = new Billing(db, c);
  const payload = JSON.stringify({
    id: "evt_test",
    type: "invoice.paid",
    livemode: false,
    data: { object: { id: "in_test" } },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: c.STRIPE_WEBHOOK_SECRET,
  });
  await Promise.all([
    billing.receive(Buffer.from(payload), signature),
    billing.receive(Buffer.from(payload), signature),
  ]);
  assert.equal((await db.query("SELECT * FROM stripe_events")).rowCount, 1);
  assert.equal((await db.query("SELECT * FROM jobs")).rowCount, 1);
  await assert.rejects(billing.receive(Buffer.from(payload), "invalid"));
});
test("live webhook cannot affect test deployment", async () => {
  const billing = new Billing(db, c);
  const payload = JSON.stringify({
    id: "evt_live",
    type: "invoice.paid",
    livemode: true,
    data: { object: { id: "in_live" } },
  });
  await assert.rejects(
    billing.receive(
      Buffer.from(payload),
      Stripe.webhooks.generateTestHeaderString({
        payload,
        secret: c.STRIPE_WEBHOOK_SECRET,
      }),
    ),
    /WRONG_BILLING_MODE/,
  );
});
test("unpaid invoices cannot grant a VM entitlement", async () => {
  const order = randomUUID();
  await db.query(
    "UPDATE tenants SET state='pending_payment',paid_until=NULL WHERE id=$1",
    [tenant],
  );
  await db.query(
    "INSERT INTO orders(id,account_id,tenant_id,kind,mode,amount_cents) VALUES($1,$2,$3,'hosting','test',2500)",
    [order, account, tenant],
  );
  const stripe = {
    subscriptions: {
      retrieve: async () => ({
        id: "sub_test",
        livemode: false,
        customer: "cus_test",
        metadata: { order_id: order, account_id: account },
        status: "incomplete",
      }),
    },
    invoices: { list: async () => ({ data: [] }) },
  };
  await new Billing(db, c, stripe as any).subscription("sub_test");
  assert.equal(
    (await db.query("SELECT state FROM tenants")).rows[0].state,
    "pending_payment",
  );
  assert.equal((await db.query("SELECT * FROM jobs")).rowCount, 0);
});
test("verified paid invoice enqueues one provision job even when repeated", async () => {
  const order = randomUUID();
  await db.query(
    "UPDATE tenants SET state='pending_payment',paid_until=NULL WHERE id=$1",
    [tenant],
  );
  await db.query(
    "INSERT INTO orders(id,account_id,tenant_id,kind,mode,amount_cents) VALUES($1,$2,$3,'hosting','test',2500)",
    [order, account, tenant],
  );
  const stripe = {
    subscriptions: {
      retrieve: async () => ({
        id: "sub_test",
        livemode: false,
        customer: "cus_test",
        metadata: { order_id: order, account_id: account },
        status: "active",
      }),
    },
    invoices: {
      list: async () => ({
        data: [
          {
            status: "paid",
            lines: {
              data: [
                {
                  pricing: { price_details: { price: "price_host" } },
                  quantity: 1,
                  amount: 2500,
                  period: { end: Math.floor(Date.now() / 1000) + 86400 },
                },
              ],
            },
          },
        ],
      }),
    },
  };
  const billing = new Billing(db, c, stripe as any);
  await Promise.all([
    billing.subscription("sub_test"),
    billing.subscription("sub_test"),
  ]);
  assert.equal(
    (await db.query("SELECT state FROM tenants")).rows[0].state,
    "provisioning",
  );
  assert.equal(
    (await db.query("SELECT * FROM jobs WHERE kind='provision'")).rowCount,
    1,
  );
});
test("cross-account access and CSRF are rejected", async () => {
  const session = token(),
    other = randomUUID();
  await db.query("INSERT INTO accounts(id,email) VALUES($1,$2)", [
    other,
    "other@test.example",
  ]);
  await db.query(
    "INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [hash(session), other],
  );
  const app = await buildApp(c, db, [model]);
  try {
    let r = await app.inject({
      method: "POST",
      url: `/api/tenants/${tenant}/access`,
      headers: { origin: c.PUBLIC_ORIGIN, cookie: `__Host-session=${session}` },
      payload: {},
    });
    assert.equal(r.statusCode, 404);
    r = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        origin: "https://evil.test",
        cookie: `__Host-session=${session}`,
      },
      payload: {},
    });
    assert.equal(r.statusCode, 403);
  } finally {
    await app.close();
  }
});
test("fresh authentication required for credential-bearing export", async () => {
  const session = token();
  await db.query(
    "INSERT INTO sessions(hash,account_id,created_at,expires_at) VALUES($1,$2,now()-interval '1 hour',now()+interval '1 hour')",
    [hash(session), account],
  );
  const app = await buildApp(c, db, [model]);
  try {
    const r = await app.inject({
      method: "POST",
      url: `/api/tenants/${tenant}/export`,
      headers: { origin: c.PUBLIC_ORIGIN, cookie: `__Host-session=${session}` },
      payload: { recipient: "age1" + "a".repeat(58) },
    });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error, "FRESH_LOGIN_REQUIRED");
  } finally {
    await app.close();
  }
});
test("single-use handoff is audience and tenant bound", async () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec(
    "CREATE TABLE tickets(id TEXT PRIMARY KEY,expiry INTEGER);CREATE TABLE sessions(hash TEXT PRIMARY KEY,created INTEGER,expiry INTEGER,action TEXT,recipient TEXT)",
  );
  const origin = "https://tenant.test",
    ticket = await handoff(c.privateKey, tenant, origin);
  await assert.rejects(
    consumeTicket(sql, c.publicKey, ticket, randomUUID(), origin),
  );
  await assert.rejects(
    consumeTicket(sql, c.publicKey, ticket, tenant, "https://wrong.test"),
  );
  await consumeTicket(sql, c.publicKey, ticket, tenant, origin);
  await assert.rejects(
    consumeTicket(sql, c.publicKey, ticket, tenant, origin),
    /ALREADY_USED/,
  );
  sql.close();
});
test("uncertain provider create is never blindly retried", async () => {
  await db.query("UPDATE tenants SET state='provisioning' WHERE id=$1", [
    tenant,
  ]);
  let creates = 0;
  const cloud = {
    find: async () => null,
    create: async () => {
      creates++;
      throw Error("NETWORK_TIMEOUT");
    },
  };
  const provisioner = new Provisioner(db, c, [model], cloud as any, {} as any);
  await assert.rejects(provisioner.provision(tenant), /NETWORK_TIMEOUT/);
  await assert.rejects(provisioner.provision(tenant), /RECONCILIATION/);
  assert.equal(creates, 1);
});
test("explicit UpCloud rejection clears credentials and allows a corrected retry", async () => {
  await db.query("UPDATE tenants SET state='provisioning' WHERE id=$1", [
    tenant,
  ]);
  let creates = 0;
  const cloud = {
    find: async () => null,
    create: async () => {
      creates++;
      throw Object.assign(
        Error("UPCLOUD_409_METADATA_DISABLED_ON_CLOUD_INIT"),
        { status: 409 },
      );
    },
  };
  const provisioner = new Provisioner(db, c, [model], cloud as any, {} as any);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(provisioner.provision(tenant), /UPCLOUD_409/);
    const row = (await db.query("SELECT * FROM tenants WHERE id=$1", [tenant]))
      .rows[0];
    for (const field of [
      "create_attempted_at",
      "bootstrap_hash",
      "bootstrap_expires_at",
      "bundle_cipher",
      "inference_key_hash",
      "inference_key_cipher",
    ])
      assert.equal(row[field], null);
  }
  assert.equal(creates, 2);
});

test("provider, single-use bootstrap, DNS and health retry reach owner setup", async (ctx) => {
  await db.query(
    "UPDATE tenants SET state='provisioning',mode='byok' WHERE id=$1",
    [tenant],
  );
  const hostname = (
    await db.query("SELECT hostname FROM tenants WHERE id=$1", [tenant])
  ).rows[0].hostname;
  const app = await buildApp(c, db, []);
  ctx.after(() => app.close());
  let creates = 0;
  const remote = {
    uuid: "vm-e2e",
    hostname,
    ip_addresses: {
      ip_address: [
        { access: "public", family: "IPv4", address: "203.0.113.2" },
      ],
    },
    storage_devices: {
      storage_device: [
        { storage: "disk-e2e", type: "disk", storage_encrypted: "yes" },
      ],
    },
  };
  const cloud = new UpCloud(
    { ...c, UPCLOUD_TOKEN: "test-token" },
    async (url, init) => {
      if (init?.method === "POST") {
        creates++;
        const { server } = JSON.parse(String(init.body));
        assert.equal(server.metadata, "yes");
        assert.ok(server.user_data.startsWith("#!/bin/bash"));
        assert.ok(!server.user_data.includes("# BOOTSTRAP_VARIABLES"));
        const payload = {
          token: server.user_data.match(/BOOTSTRAP_TOKEN='([^']+)'/)[1],
        };
        const response = await app.inject({
          method: "POST",
          url: `/bootstrap/${tenant}`,
          payload,
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().managementKey, "secret");
        assert.equal(response.json().tenantId, tenant);
        assert.equal(response.json().mode, "byok");
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: `/bootstrap/${tenant}`,
              payload,
            })
          ).statusCode,
          403,
        );
        return new Response(JSON.stringify({ server: remote }), {
          status: 202,
        });
      }
      return new Response(
        JSON.stringify(
          String(url).includes("?")
            ? { servers: { server: [] } }
            : { server: remote },
        ),
      );
    },
  );
  let healthReady = false;
  ctx.mock.method(
    globalThis,
    "fetch",
    async (url: string, init: RequestInit) => {
      assert.equal(url, `https://${hostname}/internal/status`);
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer secret",
      );
      return new Response(JSON.stringify({ installed: healthReady }));
    },
  );
  const dns = {
    ensure: async (name: string, ip: string) => {
      assert.equal(name, hostname);
      assert.equal(ip, "203.0.113.2");
      return "dns-e2e";
    },
  };
  const provisioner = new Provisioner(db, c, [], cloud, dns as any);
  await assert.rejects(provisioner.provision(tenant), /WAITING_FOR_BOOTSTRAP/);
  healthReady = true;
  await provisioner.provision(tenant);
  const row = (await db.query("SELECT * FROM tenants WHERE id=$1", [tenant]))
    .rows[0];
  assert.equal(creates, 1);
  assert.equal(row.state, "awaiting_setup");
  assert.equal(row.provider_id, "vm-e2e");
  assert.deepEqual(row.disk_ids, ["disk-e2e"]);
  assert.equal(row.dns_id, "dns-e2e");
  assert.equal(row.bootstrap_hash, null);
  assert.equal(row.bundle_cipher, null);
});

test("provider retry finds VM after response loss without creating again", async () => {
  await db.query(
    "UPDATE tenants SET state='provisioning',create_attempted_at=now() WHERE id=$1",
    [tenant],
  );
  let creates = 0;
  const hostname = (await db.query("SELECT hostname FROM tenants")).rows[0]
    .hostname;
  const cloud = {
    find: async () => ({ uuid: "vm1" }),
    details: async () => ({
      uuid: "vm1",
      hostname,
      ip_addresses: { ip_address: [] },
      storage_devices: {
        storage_device: [
          { storage: "disk1", type: "disk", storage_encrypted: "yes" },
        ],
      },
    }),
    create: async () => {
      creates++;
    },
  };
  await assert.rejects(
    new Provisioner(db, c, [model], cloud as any, {} as any).provision(tenant),
    /WAITING_FOR_PUBLIC_IP/,
  );
  assert.equal(creates, 0);
  assert.equal(
    (await db.query("SELECT provider_id FROM tenants")).rows[0].provider_id,
    "vm1",
  );
});
test("live checkout cannot be enabled without acceptance evidence", () => {
  assert.throws(() => launchGate(c));
  assert.throws(
    () =>
      launchGate({
        ...c,
        CHECKOUT_ENABLED: true,
        BILLING_MODE: "live",
        RELEASE_EVIDENCE_FILE: "release-evidence.json",
      }),
    /EVIDENCE/,
  );
});

for (const adopted of [false, true]) {
  for (const encrypted of ["yes", "no", undefined]) {
    test(`${adopted ? "adopted" : "new"} VM with encryption ${encrypted} is verified before DNS and setup`, async (t) => {
      await db.query(
        "UPDATE tenants SET mode='byok',state='provisioning' WHERE id=$1",
        [tenant],
      );
      const hostname = (await db.query("SELECT hostname FROM tenants")).rows[0]
        .hostname;
      let creates = 0;
      let dnsCalls = 0;
      let healthCalls = 0;
      t.mock.method(globalThis, "fetch", async (url: string) => {
        assert.equal(url, `https://${hostname}/internal/status`);
        healthCalls++;
        return Response.json({ installed: true });
      });
      const cloud = {
        find: async () => (adopted ? { uuid: "vm1" } : null),
        create: async () => {
          creates++;
          return { uuid: "vm1" };
        },
        details: async () => ({
          uuid: "vm1",
          hostname,
          ip_addresses: {
            ip_address: [
              { access: "public", family: "IPv4", address: "203.0.113.2" },
            ],
          },
          storage_devices: {
            storage_device: [
              { storage: "disk1", type: "disk", storage_encrypted: encrypted },
            ],
          },
        }),
      };
      const dns = {
        ensure: async () => {
          dnsCalls++;
          return "dns1";
        },
      };
      const provisioner = new Provisioner(db, c, [], cloud as any, dns as any);
      if (encrypted === "yes") await provisioner.provision(tenant);
      else {
        await assert.rejects(
          provisioner.provision(tenant),
          /PROVIDER_STORAGE_ENCRYPTION_UNVERIFIED/,
        );
        // Retried provisioning adopts the recorded VM and never creates a second one.
        await assert.rejects(
          provisioner.provision(tenant),
          /PROVIDER_STORAGE_ENCRYPTION_UNVERIFIED/,
        );
      }
      const row = (
        await db.query("SELECT * FROM tenants WHERE id=$1", [tenant])
      ).rows[0];
      assert.equal(row.provider_id, "vm1");
      assert.deepEqual(row.disk_ids, ["disk1"]);
      assert.equal(creates, adopted ? 0 : 1);
      assert.equal(dnsCalls, encrypted === "yes" ? 1 : 0);
      assert.equal(healthCalls, encrypted === "yes" ? 1 : 0);
      assert.equal(
        row.state,
        encrypted === "yes" ? "awaiting_setup" : "provisioning",
      );
    });
  }
}

test("email verification tokens are single-use and sessions contain only hashes", async () => {
  const secret = token();
  await db.query(
    "INSERT INTO login_tokens(hash,account_id,expires_at) VALUES($1,$2,now()+interval '5 minutes')",
    [hash(secret), account],
  );
  const app = await buildApp(c, db, [model]);
  try {
    const request = {
      method: "POST" as const,
      url: "/api/auth/consume",
      headers: { origin: c.PUBLIC_ORIGIN },
      payload: { token: secret },
    };
    const r = await app.inject(request);
    assert.equal(r.statusCode, 200);
    assert.match(String(r.headers["set-cookie"]), /^__Host-session=/);
    assert.match(String(r.headers["set-cookie"]), /HttpOnly/);
    assert.match(String(r.headers["set-cookie"]), /Secure/);
    assert.match(String(r.headers["set-cookie"]), /Path=\//);
    assert.doesNotMatch(String(r.headers["set-cookie"]), /Domain=/i);
    assert.equal((await app.inject(request)).statusCode, 401);
    assert.equal((await db.query("SELECT * FROM login_tokens")).rowCount, 0);
    assert.equal(
      (await db.query("SELECT hash FROM sessions")).rows[0].hash.length,
      64,
    );
  } finally {
    await app.close();
  }
});
test("expired login tokens never create a session", async () => {
  const secret = token();
  await db.query(
    "INSERT INTO login_tokens(hash,account_id,expires_at) VALUES($1,$2,now()-interval '1 minute')",
    [hash(secret), account],
  );
  const app = await buildApp(c, db, [model]);
  try {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/consume",
      headers: { origin: c.PUBLIC_ORIGIN },
      payload: { token: secret },
    });
    assert.equal(r.statusCode, 401);
    assert.equal((await db.query("SELECT * FROM sessions")).rowCount, 0);
  } finally {
    await app.close();
  }
});
test("malformed provider usage is quarantined instead of charged", async () => {
  await transaction(db, (tx) => credit(tx, account, "topup", 10000n));
  const id = await reserve(db, account, tenant, model, 1000);
  await settle(db, id, model, { prompt_tokens: NaN, completion_tokens: 10 });
  assert.equal(
    (await db.query("SELECT state FROM requests")).rows[0].state,
    "unknown",
  );
  assert.equal(
    (await db.query("SELECT balance FROM wallets")).rows[0].balance,
    "10000",
  );
});
test("stale job lease is recovered after a worker restart", async () => {
  const { Worker } = await import("../src/worker.js");
  const { enqueue } = await import("../src/db.js");
  await enqueue(db, "lease-test", "test", {});
  await db.query(
    "UPDATE jobs SET lease_token=$1,lease_until=now()-interval '1 second'",
    [randomUUID()],
  );
  const worker = new Worker(db, c, [model]);
  let handled = 0;
  worker.handle = async () => {
    handled++;
  };
  await worker.tick();
  await worker.tick();
  assert.equal(handled, 1);
  assert.ok((await db.query("SELECT done_at FROM jobs")).rows[0].done_at);
});
test("renewed entitlement protects against a queued stale suspension", async () => {
  const { Worker } = await import("../src/worker.js");
  const worker = new Worker(db, c, [model]);
  let backups = 0;
  worker.backups.take = async () => {
    backups++;
  };
  await worker.handle("suspend", { tenantId: tenant });
  assert.equal(backups, 0);
  assert.equal(
    (await db.query("SELECT state FROM tenants")).rows[0].state,
    "ready",
  );
});
test("retention deletion removes VM, disks, DNS, backups and tenant secrets", async () => {
  const { Worker } = await import("../src/worker.js");
  await db.query(
    "UPDATE tenants SET state='suspended',paid_until=now()-interval '40 days',delete_after=now()-interval '1 day',provider_id='vm1',disk_ids='[\"disk1\"]',dns_id='dns1' WHERE id=$1",
    [tenant],
  );
  const worker = new Worker(db, c, [model]);
  const actions: string[] = [];
  worker.provisioner.cloud.destroy = async (id, disks) => {
    assert.equal(id, "vm1");
    assert.deepEqual(disks, ["disk1"]);
    actions.push("vm");
  };
  worker.provisioner.dns.remove = async () => {
    actions.push("dns");
  };
  worker.backups.remove = async () => {
    actions.push("backup");
  };
  await worker.handle("delete", { tenantId: tenant });
  await worker.handle("delete", { tenantId: tenant });
  assert.deepEqual(actions, ["vm", "dns", "backup"]);
  const t = (await db.query("SELECT * FROM tenants")).rows[0];
  assert.equal(t.state, "deleted");
  assert.equal(t.management_cipher, "");
});
test("data is not deleted before the retention deadline", async () => {
  const { Worker } = await import("../src/worker.js");
  await db.query(
    "UPDATE tenants SET state='suspended',paid_until=now()-interval '10 days',delete_after=now()+interval '20 days' WHERE id=$1",
    [tenant],
  );
  const worker = new Worker(db, c, [model]);
  await worker.handle("delete", { tenantId: tenant });
  assert.equal(
    (await db.query("SELECT state FROM tenants")).rows[0].state,
    "suspended",
  );
});

test("inference proxy preserves tool calls, meters usage, and rejects unselected models", async () => {
  const key = token();
  await db.query("UPDATE tenants SET inference_key_hash=$2 WHERE id=$1", [
    tenant,
    hash(key),
  ]);
  await transaction(db, (tx) => credit(tx, account, "topup", 10000n));
  const original = globalThis.fetch;
  process.env.TEST_INFERENCE_KEY = "fixture-provider-key";
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const sent = JSON.parse(String(options?.body));
    assert.equal(sent.model, "upstream");
    assert.equal(sent.tools[0].function.name, "test_tool");
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "call1",
                type: "function",
                function: { name: "test_tool", arguments: "{}" },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
  };
  const app = await buildApp(c, db, [model]);
  try {
    const r = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: {
        model: model.id,
        messages: [{ role: "user", content: "private fixture" }],
        tools: [
          {
            type: "function",
            function: { name: "test_tool", parameters: { type: "object" } },
          },
        ],
      },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(
      r.json().choices[0].message.tool_calls[0].function.name,
      "test_tool",
    );
    assert.equal(
      (await db.query("SELECT balance FROM wallets")).rows[0].balance,
      "9850",
    );
    assert(
      !JSON.stringify((await db.query("SELECT * FROM requests")).rows).includes(
        "private fixture",
      ),
    );
    const denied = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: {
        model: "different-country-model",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    assert.equal(denied.statusCode, 400);
    assert.equal(calls, 1);
  } finally {
    await app.close();
    globalThis.fetch = original;
    delete process.env.TEST_INFERENCE_KEY;
  }
});
test("insufficient credit is rejected before making an upstream request", async () => {
  const key = token();
  await db.query("UPDATE tenants SET inference_key_hash=$2 WHERE id=$1", [
    tenant,
    hash(key),
  ]);
  const original = globalThis.fetch;
  process.env.TEST_INFERENCE_KEY = "fixture-provider-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Error("must not call");
  };
  const app = await buildApp(c, db, [model]);
  try {
    const r = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: {
        model: model.id,
        messages: [{ role: "user", content: "hello" }],
      },
    });
    assert.equal(r.statusCode, 402);
    assert.equal(calls, 0);
  } finally {
    await app.close();
    globalThis.fetch = original;
    delete process.env.TEST_INFERENCE_KEY;
  }
});

test("browser pairing extracts only a well-formed device connection key", async () => {
  const { deviceFromConnect } = await import("../src/tenant/gateway-proxy.js");
  assert.equal(
    deviceFromConnect(
      JSON.stringify({
        type: "req",
        method: "connect",
        params: { device: { publicKey: "a".repeat(43) } },
      }),
    ),
    "a".repeat(43),
  );
  assert.equal(
    deviceFromConnect(
      JSON.stringify({
        type: "req",
        method: "chat.send",
        params: { device: { publicKey: "a".repeat(43) } },
      }),
    ),
    null,
  );
  assert.equal(deviceFromConnect("not JSON"), null);
});

test("checkout retries keep identical Stripe parameters as time advances", async (t) => {
  const requests: unknown[] = [];
  const stripe = {
    prices: {
      retrieve: async () => ({
        currency: "eur",
        unit_amount: 2500,
        tax_behavior: "exclusive",
        recurring: { interval: "month", interval_count: 1 },
      }),
    },
    checkout: {
      sessions: {
        create: async (params: unknown, options: unknown) => {
          requests.push({ params, options });
          return { id: "cs_stable", url: "https://checkout.stripe.com/test" };
        },
      },
    },
  };
  const billing = new Billing(db, c, stripe as any);
  const order = {
    id: randomUUID(),
    account_id: account,
    tenant_id: tenant,
    kind: "hosting",
  };
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  await billing.checkout(order, "cus_test");
  t.mock.method(Date, "now", () => now + 5000);
  await billing.checkout(order, "cus_test");
  assert.deepEqual(requests[0], requests[1]);
});

test("catalog refuses to advertise live checkout when release evidence is missing", async (t) => {
  const app = await buildApp(
    {
      ...c,
      BILLING_MODE: "live",
      CHECKOUT_ENABLED: true,
      CREDITS_ENABLED: true,
      RELEASE_EVIDENCE_FILE: "release-evidence.json",
    },
    db,
    [model],
  );
  t.after(() => app.close());
  const catalog = (await app.inject("/api/catalog")).json();
  assert.equal(catalog.checkoutEnabled, false);
  assert.equal(catalog.creditsEnabled, false);
});

test("usage settlement persists only validated counters from upstream", async () => {
  await transaction(db, (tx) => credit(tx, account, "topup", 10000n));
  const id = await reserve(db, account, tenant, model, 1000);
  await settle(db, id, model, {
    prompt_tokens: 100,
    completion_tokens: 100,
    prompt_tokens_details: {
      cached_tokens: 50,
      prompt: "private provider text",
    },
    completion_tokens_details: {
      reasoning_tokens: 10,
      reasoning: "private reasoning text",
    },
    unexpected: "private completion text",
  } as any);
  const request = (await db.query("SELECT * FROM requests WHERE id=$1", [id]))
    .rows[0];
  assert.equal(request.state, "settled");
  assert.deepEqual(request.usage, {
    prompt_tokens: 100,
    completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 50 },
    completion_tokens_details: { reasoning_tokens: 10 },
  });
  const ledger = (
    await db.query("SELECT metadata FROM ledger WHERE kind='usage'")
  ).rows[0];
  assert.deepEqual(ledger.metadata.usage, request.usage);
  assert.doesNotMatch(JSON.stringify([request, ledger]), /private/);
});

test("invalid reasoning counters are quarantined without debiting credit", async () => {
  await transaction(db, (tx) => credit(tx, account, "topup", 10000n));
  const id = await reserve(db, account, tenant, model, 1000);
  await settle(db, id, model, {
    prompt_tokens: 10,
    completion_tokens: 20,
    completion_tokens_details: { reasoning_tokens: -1 },
  });
  assert.equal(
    (await db.query("SELECT state FROM requests WHERE id=$1", [id])).rows[0]
      .state,
    "unknown",
  );
  assert.equal(
    (await db.query("SELECT balance FROM wallets")).rows[0].balance,
    "10000",
  );
});

test("expired entitlement denies new access before the lifecycle worker catches up", async (t) => {
  await db.query(
    "UPDATE tenants SET paid_until=now()-interval '1 hour',grace_until=NULL WHERE id=$1",
    [tenant],
  );
  const session = token();
  await db.query(
    "INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [hash(session), account],
  );
  const app = await buildApp(c, db, [model]);
  t.after(() => app.close());
  const request = {
    method: "POST" as const,
    url: `/api/tenants/${tenant}/access`,
    headers: { origin: c.PUBLIC_ORIGIN, cookie: `__Host-session=${session}` },
    payload: {},
  };
  assert.equal((await app.inject(request)).statusCode, 409);
  await db.query(
    "UPDATE tenants SET grace_until=now()+interval '1 day' WHERE id=$1",
    [tenant],
  );
  assert.equal((await app.inject(request)).statusCode, 200);
});

test("suspension rejects existing access sessions but preserves export sessions", async () => {
  const { tenantSession } = await import("../src/tenant/session.js");
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(
      "CREATE TABLE sessions(hash TEXT PRIMARY KEY,expiry INTEGER,action TEXT); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)",
    );
    for (const action of ["access", "export"])
      sql
        .prepare("INSERT INTO sessions VALUES(?,?,?)")
        .run(hash(action), Date.now() + 60000, action);
    assert.equal(tenantSession(sql, "access").action, "access");
    sql.prepare("INSERT INTO settings VALUES('suspended','true')").run();
    assert.throws(() => tenantSession(sql, "access"), /AGENT_SUSPENDED/);
    assert.equal(tenantSession(sql, "export").action, "export");
    assert.throws(() => tenantSession(sql, "unknown"), /SIGN_IN/);
  } finally {
    sql.close();
  }
});

test("email sign-in carries the selected inference mode without an external redirect", async (t) => {
  const nodemailer = (await import("nodemailer")).default;
  let sent: any;
  t.mock.method(
    nodemailer,
    "createTransport",
    () =>
      ({
        sendMail: async (mail: any) => {
          sent = mail;
        },
      }) as any,
  );
  const app = await buildApp(
    {
      ...c,
      SMTP_URL: "smtp://test.invalid",
      EMAIL_FROM: "test@example.invalid",
    },
    db,
    [model],
  );
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/request",
    headers: { origin: c.PUBLIC_ORIGIN },
    payload: { email: "customer@example.invalid", mode: "credits" },
  });
  assert.equal(response.statusCode, 202);
  const url = new URL(sent.text.split("\n")[0].slice(5));
  assert.equal(url.origin, c.PUBLIC_ORIGIN);
  assert.equal(url.searchParams.get("mode"), "credits");
  assert.match(url.hash, /^#login=/);
  const bad = await app.inject({
    method: "POST",
    url: "/api/auth/request",
    headers: { origin: c.PUBLIC_ORIGIN },
    payload: { email: "customer@example.invalid", mode: "https://evil.test" },
  });
  assert.equal(bad.statusCode, 400);
});

test("paid founders retain cohort places after deletion; abandoned unpaid accounts do not", async (t) => {
  const founderOrder = randomUUID();
  await db.query(
    "INSERT INTO orders(id,account_id,tenant_id,kind,mode,amount_cents,state) VALUES($1,$2,$3,'hosting','test',2500,'paid')",
    [founderOrder, account, tenant],
  );
  await db.query("UPDATE tenants SET state='deleted' WHERE id=$1", [tenant]);
  const applicant = randomUUID(),
    session = token();
  await db.query(
    "INSERT INTO accounts(id,email,stripe_customer) VALUES($1,'applicant@test.example','cus_applicant')",
    [applicant],
  );
  await db.query(
    "INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [hash(session), applicant],
  );
  const billing = new Billing(db, c);
  billing.checkout = async () =>
    ({ id: "cs_fixture", url: "https://checkout.stripe.com/fixture" }) as any;
  const app = await buildApp(
    { ...c, CHECKOUT_ENABLED: true, MAX_TENANTS: 1 },
    db,
    [model],
    billing,
  );
  t.after(() => app.close());
  const request = {
    method: "POST" as const,
    url: "/api/checkout",
    headers: { origin: c.PUBLIC_ORIGIN, cookie: `__Host-session=${session}` },
    payload: { mode: "byok" },
  };
  const full = await app.inject(request);
  assert.equal(full.statusCode, 409);
  assert.equal(full.json().error, "COHORT_FULL");
  await db.query("UPDATE orders SET state='expired' WHERE id=$1", [
    founderOrder,
  ]);
  assert.equal((await app.inject(request)).statusCode, 200);
});

test("a crashed request blocks dispatch before maintenance and keeps its reserve", async () => {
  await transaction(db, (tx) => credit(tx, account, "topup", 10000n));
  const id = await reserve(db, account, tenant, model, 1000);
  await db.query(
    "UPDATE requests SET created_at=now()-interval '6 minutes' WHERE id=$1",
    [id],
  );
  await assert.rejects(
    reserve(db, account, tenant, model, 1000),
    /USAGE_RECONCILIATION_REQUIRED/,
  );
  await Promise.all([quarantineStaleUsage(db), quarantineStaleUsage(db)]);
  assert.equal(
    (await db.query("SELECT reserved FROM wallets")).rows[0].reserved,
    "2500",
  );
  assert.equal((await db.query("SELECT * FROM incidents")).rowCount, 1);
  // A late usage response can still settle exactly once after quarantine.
  await Promise.all([
    settle(db, id, model, { prompt_tokens: 100, completion_tokens: 100 }),
    quarantineStaleUsage(db),
  ]);
  assert.equal(
    (await db.query("SELECT balance,reserved FROM wallets")).rows[0].balance,
    "9750",
  );
  await reserve(db, account, tenant, model, 1000);
});

test("confirmed unbilled usage releases a hold without charging", async () => {
  await transaction(db, (tx) => credit(tx, account, "topup", 10000n));
  const id = await reserve(db, account, tenant, model, 1000);
  await settle(db, id, model, null);
  await settle(
    db,
    id,
    model,
    { prompt_tokens: 0, completion_tokens: 0 },
    "provider-confirmed-unbilled",
  );
  assert.deepEqual(
    (await db.query("SELECT balance,reserved FROM wallets")).rows[0],
    { balance: "10000", reserved: "0" },
  );
  assert.equal(
    (await db.query("SELECT * FROM incidents WHERE resolved_at IS NULL"))
      .rowCount,
    0,
  );
});

test("unresolved usage rejects HTTP inference before another provider call", async (t) => {
  await transaction(db, (tx) => credit(tx, account, "topup", 10000n));
  const id = await reserve(db, account, tenant, model, 1000);
  await settle(db, id, model, null);
  const key = token();
  await db.query("UPDATE tenants SET inference_key_hash=$2 WHERE id=$1", [
    tenant,
    hash(key),
  ]);
  process.env.TEST_INFERENCE_KEY = "test-only";
  t.after(() => {
    delete process.env.TEST_INFERENCE_KEY;
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("unexpected upstream call");
  });
  const app = await buildApp(c, db, [model]);
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${key}` },
    payload: { model: model.id, messages: [{ role: "user", content: "test" }] },
  });
  assert.equal(response.statusCode, 402);
  assert.equal(response.json().error, "USAGE_RECONCILIATION_REQUIRED");
});

test("suspension parks compute despite unreachable tenant and backup, and retries safely", async (t) => {
  const { Worker } = await import("../src/worker.js");
  await db.query(
    "UPDATE tenants SET paid_until=now()-interval '1 day',provider_id='vm1' WHERE id=$1",
    [tenant],
  );
  const worker = new Worker(db, c, [model]);
  let plan = "STARTER-2xCPU-4GB",
    attempts = 0;
  worker.provisioner.cloud.details = async () => ({
    hostname: `${tenant}.agents.test`,
    plan,
  });
  worker.backups.take = async () => {
    throw Error("BACKUP_UNAVAILABLE");
  };
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("TENANT_UNREACHABLE");
  });
  worker.provisioner.cloud.park = async () => {
    attempts++;
    // Simulate provider accepting the plan change then losing the response.
    plan = "CLOUDNATIVE-1xCPU-4GB";
    if (attempts === 1) throw Error("NETWORK_FAILURE");
  };
  await assert.rejects(
    worker.handle("suspend", { tenantId: tenant }),
    /NETWORK_FAILURE/,
  );
  const first = (await db.query("SELECT * FROM tenants")).rows[0];
  assert.equal(first.state, "suspended");
  assert.equal(first.resume_plan, "STARTER-2xCPU-4GB");
  await worker.handle("suspend", { tenantId: tenant });
  const second = (await db.query("SELECT * FROM tenants")).rows[0];
  assert.equal(second.resume_plan, first.resume_plan);
  assert.equal(+second.delete_after, +first.delete_after);
  assert.equal(attempts, 2);
  // A previously queued backup cannot wake or call a parked tenant.
  await worker.handle("backup", { tenantId: tenant });
});

test("paid recovery restores saved plan before starting and survives an HTTP retry", async (t) => {
  const { Worker } = await import("../src/worker.js");
  await db.query(
    "UPDATE tenants SET state='suspended',provider_id='vm1',resume_plan='STARTER-2xCPU-4GB',suspended_at=now(),delete_after=now()+interval '30 days' WHERE id=$1",
    [tenant],
  );
  const worker = new Worker(db, c, [model]);
  let plan = "CLOUDNATIVE-1xCPU-4GB",
    state = "stopped",
    http = 0;
  const actions: string[] = [];
  worker.provisioner.cloud.details = async () => ({
    hostname: `${tenant}.agents.test`,
    plan,
    state,
  });
  worker.provisioner.cloud.stop = async () => {
    state = "stopped";
  };
  worker.provisioner.cloud.changeStoppedPlan = async (_id, next) => {
    assert.equal(state, "stopped");
    plan = next;
    actions.push("restore-plan");
  };
  worker.provisioner.cloud.start = async () => {
    assert.equal(plan, "STARTER-2xCPU-4GB");
    state = "started";
    actions.push("start");
  };
  t.mock.method(globalThis, "fetch", async () => {
    actions.push("resume-agent");
    if (++http === 1) throw Error("BOOTING");
    return Response.json({ ok: true });
  });
  await assert.rejects(
    worker.handle("resume", { tenantId: tenant }),
    /BOOTING/,
  );
  assert.equal(
    (await db.query("SELECT state FROM tenants")).rows[0].state,
    "suspended",
  );
  await worker.handle("resume", { tenantId: tenant });
  assert.deepEqual(actions, [
    "restore-plan",
    "start",
    "resume-agent",
    "start",
    "resume-agent",
  ]);
  const row = (await db.query("SELECT * FROM tenants")).rows[0];
  assert.equal(row.state, "awaiting_setup");
  assert.equal(row.resume_plan, null);
  assert.equal(row.delete_after, null);
});

test("expired entitlement cannot restart retained compute", async () => {
  const { Worker } = await import("../src/worker.js");
  await db.query(
    "UPDATE tenants SET state='suspended',paid_until=now()-interval '1 day',provider_id='vm1',resume_plan='STARTER-2xCPU-4GB' WHERE id=$1",
    [tenant],
  );
  const worker = new Worker(db, c, [model]);
  worker.provisioner.cloud.details = async () => {
    throw Error("must not touch cloud");
  };
  await worker.handle("resume", { tenantId: tenant });
  assert.equal(
    (await db.query("SELECT state FROM tenants")).rows[0].state,
    "suspended",
  );
});

test("lifecycle operations serialize against a competing tenant operation", async () => {
  const { Worker } = await import("../src/worker.js");
  const conn = await db.connect();
  try {
    await conn.query("SELECT pg_advisory_lock(hashtext($1))", [tenant]);
    const worker = new Worker(db, c, [model]);
    await assert.rejects(
      worker.handle("suspend", { tenantId: tenant }),
      /TENANT_BUSY/,
    );
  } finally {
    await conn.query("SELECT pg_advisory_unlock(hashtext($1))", [tenant]);
    conn.release();
  }
});

test("billing portal rejects old sessions before contacting Stripe", async () => {
  const session = token();
  await db.query(
    "INSERT INTO sessions(hash,account_id,created_at,expires_at) VALUES($1,$2,now()-interval '1 hour',now()+interval '1 hour')",
    [hash(session), account],
  );
  let calls = 0;
  const billing = new Billing(db, c, {
    billingPortal: {
      sessions: {
        create: async () => {
          calls++;
          return { url: "https://billing.stripe.com/test" };
        },
      },
    },
  } as any);
  const app = await buildApp(c, db, [model], billing);
  try {
    const request = {
      method: "POST" as const,
      url: "/api/billing/portal",
      headers: { origin: c.PUBLIC_ORIGIN, cookie: `__Host-session=${session}` },
      payload: {},
    };
    const stale = await app.inject(request);
    assert.equal(stale.statusCode, 403);
    assert.equal(stale.json().error, "FRESH_LOGIN_REQUIRED");
    assert.equal(calls, 0);
    await db.query("UPDATE sessions SET created_at=now() WHERE hash=$1", [
      hash(session),
    ]);
    assert.equal((await app.inject(request)).statusCode, 200);
    assert.equal(calls, 1);
    const legacy = await app.inject({
      ...request,
      headers: { origin: c.PUBLIC_ORIGIN, cookie: `session=${session}` },
    });
    assert.equal(legacy.statusCode, 401);
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test("managed streaming forwards the first chunk before completion and logs only timing metadata", async (t) => {
  const key = token();
  await db.query("UPDATE tenants SET inference_key_hash=$2 WHERE id=$1", [
    tenant,
    hash(key),
  ]);
  await transaction(db, (tx) => credit(tx, account, "timing-topup", 10000n));
  const original = globalThis.fetch;
  process.env.TEST_INFERENCE_KEY = "fixture-provider-key";
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          c.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"private-stream-answer"}}]}\n\n',
            ),
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const app = await buildApp(c, db, [model]);
  let record: any;
  let logged!: () => void;
  const logReady = new Promise<void>((resolve) => {
    logged = resolve;
  });
  app.log.info = ((data: any) => {
    if (data.event === "inference_timing") {
      record = data;
      logged();
    }
  }) as any;
  t.after(async () => {
    try {
      controller?.close();
    } catch {}
    globalThis.fetch = original;
    delete process.env.TEST_INFERENCE_KEY;
    await app.close();
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await original(`${address}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: model.id,
      stream: true,
      messages: [{ role: "user", content: "private-prompt" }],
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /private-stream-answer/);
  assert.equal(record, undefined, "request is still streaming");
  controller.enqueue(
    encoder.encode(
      'data: {"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\ndata: [DONE]\n\n',
    ),
  );
  controller.close();
  while (!(await reader.read()).done) {}
  await logReady;
  assert.deepEqual(
    Object.keys(record).sort(),
    [
      "event",
      "requestId",
      "streaming",
      "outcome",
      "headersMs",
      "firstUpstreamChunkMs",
      "generationMs",
      "totalMs",
      "settlement",
    ].sort(),
  );
  assert.equal(record.outcome, "completed");
  assert.equal(record.settlement, "processed");
  assert.equal(record.streaming, true);
  assert.ok(record.headersMs >= 0);
  assert.ok(record.firstUpstreamChunkMs >= record.headersMs);
  assert.ok(record.generationMs >= record.firstUpstreamChunkMs);
  assert.ok(record.totalMs >= record.generationMs);
  assert.equal(record.requestId, response.headers.get("x-request-id"));
  assert.doesNotMatch(JSON.stringify(record), /private-|fixture-provider-key/);
  assert.equal(
    (await db.query("SELECT balance FROM wallets")).rows[0].balance,
    "9850",
  );
});

test("provider failures emit timing metadata without claiming a completed generation", async (t) => {
  const key = token();
  await db.query("UPDATE tenants SET inference_key_hash=$2 WHERE id=$1", [
    tenant,
    hash(key),
  ]);
  await transaction(db, (tx) =>
    credit(tx, account, "timing-failure-topup", 10000n),
  );
  const original = globalThis.fetch;
  process.env.TEST_INFERENCE_KEY = "fixture-provider-key";
  globalThis.fetch = async () => {
    throw Error("private provider URL and diagnostic");
  };
  const app = await buildApp(c, db, [model]);
  t.after(async () => {
    globalThis.fetch = original;
    delete process.env.TEST_INFERENCE_KEY;
    await app.close();
  });
  const records: any[] = [];
  app.log.info = ((data: any) => {
    if (data.event === "inference_timing") records.push(data);
  }) as any;
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${key}` },
    payload: {
      model: model.id,
      messages: [{ role: "user", content: "private-prompt" }],
    },
  });
  assert.equal(response.statusCode, 500);
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "failed");
  assert.equal(records[0].headersMs, null);
  assert.equal(records[0].firstUpstreamChunkMs, null);
  assert.equal(records[0].generationMs, null);
  assert.equal(records[0].settlement, "processed");
  assert.doesNotMatch(JSON.stringify(records), /private|fixture-provider-key/);
  assert.equal(
    (await db.query("SELECT state FROM requests")).rows[0].state,
    "unknown",
  );
});
