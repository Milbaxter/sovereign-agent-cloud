import { test } from "node:test";
import assert from "node:assert/strict";
import { loginLink } from "../e2e/inbox.js";
import { manifestSchema } from "../e2e/config.js";
import { currentPrompt, wizardChoices } from "../e2e/openclaw.js";
import { quote } from "../scripts/journey/control.js";
const origin = "https://control.203-0-113-2.sslip.io";
const token = "a".repeat(48),
  since = Date.now();
const mail = (text: string, changes: Record<string, unknown> = {}) => ({
  internalDate: String(since),
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "To", value: "Journey <owner@example.com>" },
      { name: "Subject", value: "Sign in to Your Agent" },
    ],
    parts: [
      {
        mimeType: "text/plain",
        body: { data: Buffer.from(text).toString("base64url") },
      },
    ],
  },
  ...changes,
});
test("delivered signup links must match recipient, time, mode and exact owned origin", () => {
  const good = `${origin}/?mode=byok#login=${token}`,
    m = { origin, mode: "byok" as const };
  assert.equal(
    loginLink(mail(`Open ${good}`), m, "owner@example.com", since),
    good,
  );
  assert.equal(loginLink(mail(good), m, "other@example.com", since), undefined);
  assert.equal(
    loginLink(
      mail(good, { internalDate: String(since - 3000) }),
      m,
      "owner@example.com",
      since,
    ),
    undefined,
  );
  for (const bad of [
    good.replace("byok", "credits"),
    good.replace("control.", "evil.control."),
    good.replace("https://", "http://"),
    good.replace(token, "short"),
    good.replace("/?", "/evil?"),
    good.replace("https://", "https://attacker@"),
  ])
    assert.equal(
      loginLink(mail(bad), m, "owner@example.com", since),
      undefined,
    );
  assert.equal(
    loginLink(mail(`${good}\n${good}`), m, "owner@example.com", since),
    undefined,
  );
});
test("manifest rejects hostname/IP ownership drift before browser navigation", () => {
  const value = {
    runId: "journey-12345678",
    mode: "byok",
    origin,
    controlId: "009f4eaf-6a41-4b71-82ac-561ff4e80174",
    controlIp: "203.0.113.2",
    controlHostname: "journey-12345678",
    tenantDomain: "journey-12345678.invalid",
    hostingPrice: "price_h",
    creditPrice: "price_c",
    webhookId: "we_t",
    runtimeImage: `ghcr.io/milbaxter/sovereign-agent-cloud:sha-${"a".repeat(40)}@sha256:${"b".repeat(64)}`,
    openclawImage:
      "ghcr.io/openclaw/openclaw:2026.9.6-browser@sha256:62832668e3e5e139f745f7d3df892c9251eb53318b7d14a76c410dde1f25d730",
    model: "gpt-4.1-mini-2025-04-14",
    modelId: "openai-journey",
    markerUrl: `${origin}/journey-marker`,
    marker: `JOURNEY_${"A".repeat(32)}`,
    createdAt: new Date().toISOString(),
  };
  assert.equal(manifestSchema.safeParse(value).success, true);
  for (const change of [
    { controlIp: "203.0.113.3" },
    { tenantDomain: "other.invalid" },
    { origin: "https://production.example.com" },
    { markerUrl: "https://other.example/marker" },
    { runtimeImage: "ghcr.io/example/app:latest" },
  ])
    assert.equal(
      manifestSchema.safeParse({ ...value, ...change }).success,
      false,
    );
});
test("wizard reads only the active prompt and refuses unfamiliar questions", () => {
  const text =
    "◇  Setup mode\n│ QuickStart\n◆  Config handling\n│ ● Keep current values (recommended)\n│ ○ Review and update\n└";
  assert.deepEqual(currentPrompt(text), {
    question: "Config handling",
    options: [
      { label: "Keep current values", selected: true },
      { label: "Review and update", selected: false },
    ],
  });
  assert.equal(
    currentPrompt("◇  Config handling\n│ Keep current values"),
    undefined,
  );
  assert.equal(
    wizardChoices("byok").some((c) =>
      c.question.test("Install unknown extension?"),
    ),
    false,
  );
  assert.equal(
    wizardChoices("credits")
      .find((c) => c.question.test("Setup mode"))
      ?.option?.test("Keep existing model config"),
    true,
  );
});
test("remote command quoting preserves literal shell metacharacters", () => {
  assert.equal(quote("a'$(echo secret)`x`"), "'a'\\''$(echo secret)`x`'");
});

test("billing cleanup outages never prevent cloud cleanup", async () => {
  const { cleanupStages } = await import("../scripts/journey/cleanup-order.js");
  const seen: string[] = [];
  const failures = await cleanupStages([
    {
      name: "BILLING",
      run: async () => {
        seen.push("billing");
        throw Error("private provider failure");
      },
    },
    {
      name: "CLOUD",
      run: async () => {
        seen.push("cloud");
      },
    },
  ]);
  assert.deepEqual(seen, ["billing", "cloud"]);
  assert.deepEqual(failures, ["BILLING"]);
});
