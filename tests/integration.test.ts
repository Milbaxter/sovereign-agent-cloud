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
  releaseUnknown,
} from "../src/ledger.js";
import { hash, token, seal, unseal, handoff } from "../src/crypto.js";
import { Billing } from "../src/billing.js";
import { buildApp } from "../src/app.js";
import { Provisioner } from "../src/provision.js";
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
test("unknown usage holds funds then is waived without inventing a charge", async () => {
  await transaction(db, (tx) => credit(tx, account, "topup", 10000n));
  const id = await reserve(db, account, tenant, model, 1000);
  await settle(db, id, model, null);
  assert.equal(
    (await db.query("SELECT state FROM requests")).rows[0].state,
    "unknown",
  );
  await db.query("UPDATE requests SET created_at=now()-interval '25 hours'");
  await releaseUnknown(db);
  const w = (await db.query("SELECT * FROM wallets")).rows[0];
  assert.equal(w.balance, "10000");
  assert.equal(w.reserved, "0");
  assert.equal(
    (await db.query("SELECT state FROM requests")).rows[0].state,
    "waived",
  );
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
      headers: { origin: c.PUBLIC_ORIGIN, cookie: `session=${session}` },
      payload: {},
    });
    assert.equal(r.statusCode, 404);
    r = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { origin: "https://evil.test", cookie: `session=${session}` },
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
      headers: { origin: c.PUBLIC_ORIGIN, cookie: `session=${session}` },
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
      storage_devices: { storage_device: [{ storage: "disk1" }] },
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
    assert.match(String(r.headers["set-cookie"]), /HttpOnly/);
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
