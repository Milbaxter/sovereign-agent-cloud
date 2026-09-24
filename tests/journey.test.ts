import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, type Config } from "../src/config.js";
import { DNS } from "../src/providers/dns.js";
import { providerHostname, publicHostname } from "../src/providers/hostname.js";
import { buildApp } from "../src/app.js";
import type { DB } from "../src/db.js";

test("temporary DNS is restricted to test billing, a single inbox and no indexing", () => {
  const dir = mkdtempSync(join(tmpdir(), "journey-config-"));
  const key = join(dir, "key");
  writeFileSync(key, "test fixture only");
  const env = {
    DATABASE_URL: "postgres://test",
    PUBLIC_ORIGIN: "https://portal.test",
    TENANT_DOMAIN: "agents.test",
    ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    HANDOFF_PRIVATE_KEY_FILE: key,
    HANDOFF_PUBLIC_KEY_FILE: key,
    BILLING_MODE: "test",
    DNS_MODE: "test_sslip",
    TEST_ACCOUNT_EMAIL: "owner@example.com",
  };
  try {
    assert.equal(config(env).DNS_MODE, "test_sslip");
    assert.throws(
      () => config({ ...env, BILLING_MODE: "live" }),
      /TEST_CONFIG_REQUIRES_TEST_BILLING/,
    );
    assert.throws(
      () => config({ ...env, TEST_ACCOUNT_EMAIL: "" }),
      /PRIVATE_TEST_ACCOUNT/,
    );
    assert.throws(
      () => config({ ...env, SEARCH_INDEXING_ENABLED: "true" }),
      /PRIVATE_TEST_ACCOUNT/,
    );
    assert.equal(
      config({ ...env, DNS_MODE: undefined, TEST_ACCOUNT_EMAIL: "" }).DNS_MODE,
      "cloudflare",
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("temporary hostname preserves immutable provider identity and never calls Cloudflare", async (t) => {
  const c = { DNS_MODE: "test_sslip", BILLING_MODE: "test" } as Config;
  const tenant = {
    id: "tenant",
    hostname: "old.agents.test",
    provider_hostname: "vm.agents.test",
  };
  const hostname = publicHostname(c, tenant, "203.0.113.2");
  assert.equal(hostname, "a-tenant.203-0-113-2.sslip.io");
  assert.equal(providerHostname({ ...tenant, hostname }), "vm.agents.test");
  assert.equal(
    publicHostname({ ...c, DNS_MODE: "cloudflare" }, tenant, "203.0.113.2"),
    tenant.hostname,
  );
  assert.throws(
    () => publicHostname({ ...c, BILLING_MODE: "live" }, tenant, "203.0.113.2"),
    /TEST_BILLING/,
  );
  assert.throws(() => publicHostname(c, tenant, "::1"), /PUBLIC_IPV4_REQUIRED/);
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("Network must not be called");
  });
  const dns = new DNS(c);
  const id = await dns.ensure(hostname, "203.0.113.2");
  await dns.remove(id);
  await assert.rejects(
    dns.ensure(hostname, "203.0.113.3"),
    /INVALID_TEST_HOSTNAME/,
  );
  await assert.rejects(
    new DNS({ ...c, BILLING_MODE: "live" }).remove(id),
    /TEST_BILLING/,
  );
});

test("journey signup rejects other inboxes before touching SMTP or the database", async (t) => {
  const app = await buildApp(
    {
      PUBLIC_ORIGIN: "https://portal.test",
      BILLING_MODE: "test",
      TEST_ACCOUNT_EMAIL: "owner@example.com",
    } as Config,
    {
      query: async () => {
        throw Error("No database access expected");
      },
    } as unknown as DB,
    [],
  );
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/request",
    headers: { origin: "https://portal.test" },
    payload: { email: "someone-else@example.com" },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, "TEST_ACCOUNT_ONLY");
});
