import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import type { DB } from "../src/db.js";
import { availability, portalPath } from "../public/welcome/portal.js";

const liveCatalog = {
  hostingMonthlyCents: 2500,
  creditTopupCents: 1000,
  checkoutEnabled: true,
  creditsEnabled: true,
  billingMode: "live",
  models: [{ id: "verified-model" }],
};

test("marketing selections map only to the existing account portal modes", () => {
  assert.equal(portalPath("byok"), "/?mode=byok");
  assert.equal(portalPath("prepaid"), "/?mode=credits");
  assert.equal(portalPath("https://unexpected.example"), "/?mode=byok");
});

test("marketing never advertises live checkout for missing or invalid catalog data", () => {
  for (const catalog of [
    null,
    {},
    { ...liveCatalog, billingMode: "unknown" },
    { ...liveCatalog, checkoutEnabled: "true" },
    { ...liveCatalog, hostingMonthlyCents: 9900 },
    { ...liveCatalog, models: null },
  ]) {
    const state = availability(catalog, "byok");
    assert.equal(state.label, "Open account portal");
    assert.match(state.banner, /Check availability/);
  }
});

test("test billing, disabled checkout, and unavailable credit models stay explicit", () => {
  assert.match(
    availability({ ...liveCatalog, billingMode: "test" }, "byok").banner,
    /No live purchases/,
  );
  assert.match(
    availability({ ...liveCatalog, checkoutEnabled: false }, "byok").banner,
    /not open yet/,
  );
  assert.match(
    availability({ ...liveCatalog, creditsEnabled: false }, "prepaid").note,
    /not available yet/,
  );
  assert.match(
    availability({ ...liveCatalog, models: [] }, "prepaid").note,
    /not available yet/,
  );
  assert.equal(availability(liveCatalog, "byok").label, "Continue to account");
  assert.equal(
    availability(liveCatalog, "prepaid").label,
    "Continue to account",
  );
});

test("marketing and its assets are served alongside the unchanged authenticated portal", async (t) => {
  const c = {
    PUBLIC_ORIGIN: "https://portal.test",
    BILLING_MODE: "test",
    CHECKOUT_ENABLED: false,
    CREDITS_ENABLED: false,
  } as Config;
  const db = {
    query: async () => {
      throw Error("Marketing must not query customer data");
    },
  } as unknown as DB;
  const app = await buildApp(c, db, []);
  t.after(() => app.close());
  const page = await app.inject("/welcome/");
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Your personal AI/);
  assert.match(page.body, /Milbaxter\/sovereign-agent-cloud/);
  assert.match(page.body, /Illustrative walkthrough/);
  assert.match(page.body, /noindex,nofollow/);
  assert.match(page.body, /id="account-link"[\s\S]*?href="\/\?mode=byok"/);
  assert.match(
    String(page.headers["content-security-policy"]),
    /script-src 'self'/,
  );
  assert.doesNotMatch(
    page.body,
    /data:image|buy\.stripe\.com|sk_live_|sk_test_/,
  );

  // Real HTTP handler checks catch nested-path asset regressions and CSP-incompatible favicons.
  const resources = [...page.body.matchAll(/(?:src|href)="([^"#]+)"/g)]
    .map((match) => match[1])
    .filter((path) => !path.startsWith("/") && !path.startsWith("https:"));
  for (const path of new Set(resources)) {
    const asset = await app.inject(`/welcome/${path}`);
    assert.equal(asset.statusCode, 200, path);
  }
  const helper = await app.inject("/welcome/portal.js");
  assert.equal(helper.statusCode, 200);
  const sample = await app.inject("/welcome/sample-export.json");
  assert.equal(sample.json().illustrative_only, true);
  assert.equal(sample.json().not_a_live_product_export, true);
  const root = await app.inject("/?mode=credits");
  assert.equal(root.statusCode, 200);
  assert.match(root.body, /id="login-form"/);
  assert.match(root.body, /href="\/welcome\/"/);
  const portalScript = await app.inject("/app.js");
  assert.equal(portalScript.statusCode, 200);
  assert.match(portalScript.body, /\/api\/checkout/);
  const catalog = await app.inject("/api/catalog");
  assert.equal(catalog.json().checkoutEnabled, false);
  const checkout = await app.inject({
    method: "POST",
    url: "/api/checkout",
    headers: { origin: c.PUBLIC_ORIGIN },
    payload: { mode: "byok" },
  });
  assert.equal(checkout.statusCode, 401);
  assert.equal(checkout.json().error, "LOGIN_REQUIRED");
});
