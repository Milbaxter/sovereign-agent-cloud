import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { tenantSecurity } from "../src/tenant/security.js";

// Exercise the real router and security hook; no cloud resources are modified.
test("every spelling of a management route requires its bearer secret", async () => {
  const app = Fastify();
  const origin = "https://tenant.test";
  tenantSecurity(app, origin, "management-test-secret");
  let calls = 0;
  for (const route of [
    "status",
    "backup",
    "suspend",
    "resume",
    "ssh-key",
    "prepaid",
  ])
    app.route({
      method: route === "status" ? "GET" : "POST",
      url: `/internal/${route}`,
      handler: async () => {
        calls++;
        return { ok: true };
      },
    });
  try {
    for (const segment of [
      "internal",
      "%69nternal",
      "in%74ernal",
      "%69%6e%74%65%72%6e%61%6c",
    ])
      for (const route of [
        "status",
        "backup",
        "suspend",
        "resume",
        "ssh-key",
        "prepaid",
      ]) {
        const method = route === "status" ? "GET" : "POST";
        const url = `/${segment}/${route}`;
        for (const authorization of [undefined, "Bearer wrong"]) {
          const response = await app.inject({
            method,
            url,
            headers: { origin, ...(authorization ? { authorization } : {}) },
          });
          assert.equal(response.statusCode, 401, `${method} ${url}`);
        }
        assert.equal(calls, 0);
      }
    assert.equal(
      (
        await app.inject({
          url: "/%69nternal/status",
          headers: { authorization: "Bearer management-test-secret" },
        })
      ).statusCode,
      200,
    );
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test("tenant mutations require the exact owner origin", async () => {
  const app = Fastify();
  tenantSecurity(app, "https://tenant.test", "management-test-secret");
  app.post("/handoff", async () => ({ ok: true }));
  try {
    for (const origin of [undefined, "https://other.tenant.test", "null"]) {
      const response = await app.inject({
        method: "POST",
        url: "/handoff",
        headers: origin ? { origin } : {},
      });
      assert.equal(response.statusCode, 403);
    }
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/handoff",
          headers: { origin: "https://tenant.test" },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});

test("live checkout stays blocked until security evidence is recorded", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { launchGate } = await import("../src/config.js");
  const dir = await mkdtemp(join(tmpdir(), "sac-security-gate-"));
  const path = join(dir, "evidence.json");
  const evidence = Object.fromEntries(
    [
      "paidProvisioning",
      "byokOnboarding",
      "creditOnboarding",
      "channels",
      "isolation",
      "ledger",
      "migration",
      "backupLifecycle",
      "pilot",
    ].map((name) => [name, { passed: true, evidence: "fixture" }]),
  );
  const config = {
    CHECKOUT_ENABLED: true,
    CREDITS_ENABLED: true,
    BILLING_MODE: "live",
    RELEASE_EVIDENCE_FILE: path,
  } as any;
  try {
    await writeFile(path, JSON.stringify(evidence));
    assert.throws(() => launchGate(config), /LAUNCH_EVIDENCE_MISSING/);
    evidence.productionSecurity = {
      passed: false,
      evidence: "audit still has blockers",
    };
    await writeFile(path, JSON.stringify(evidence));
    assert.throws(() => launchGate(config), /LAUNCH_EVIDENCE_MISSING/);
    evidence.productionSecurity = {
      passed: true,
      evidence: "verified deployment evidence",
    };
    await writeFile(path, JSON.stringify(evidence));
    assert.doesNotThrow(() => launchGate(config));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
