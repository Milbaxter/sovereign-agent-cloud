import { test, expect } from "@playwright/test";
import Stripe from "stripe";
import { randomBytes } from "node:crypto";
import { manifest, secret } from "./config.js";
import { GmailInbox } from "./inbox.js";
import { evidence, portalScreenshot } from "./evidence.js";
import { cloud, sql } from "../scripts/journey/control.js";
import { assertEncryptedStorage } from "../src/providers/upcloud.js";
import {
  completeWizard,
  connectDashboard,
  observeGateway,
  sendChat,
} from "./openclaw.js";
import { payCheckout } from "./payments.js";

test("clean customer journey: delivered email to working OpenClaw", async ({
  page,
  context,
}, info) => {
  const m = manifest(),
    inbox = new GmailInbox(),
    stripe = new Stripe(secret("STRIPE_SECRET_KEY"));
  await evidence(info, "identity", {
    runId: m.runId,
    mode: m.mode,
    runtimeImage: m.runtimeImage,
    openclawImage: m.openclawImage,
    model: m.model,
  });
  const initial = await sql(
    m,
    "SELECT (SELECT count(*) FROM accounts)::int AS accounts,(SELECT count(*) FROM tenants)::int AS tenants,(SELECT count(*) FROM orders)::int AS orders",
  );
  expect(initial[0]).toEqual({ accounts: 0, tenants: 0, orders: 0 });
  const health = await context.request.get(`${m.origin}/healthz`);
  expect(health.status()).toBe(200);
  expect(health.headers()["x-robots-tag"]).toContain("noindex");
  await page.goto(`${m.origin}/welcome/`);
  await page
    .locator(
      `input[name="inference"][value="${m.mode === "credits" ? "prepaid" : "byok"}"]`,
    )
    .check();
  await page
    .getByRole("link", { name: "Open account portal", exact: true })
    .click();
  await expect(page).toHaveURL(`${m.origin}/?mode=${m.mode}`);
  const sentAt = Date.now();
  await page
    .getByLabel("Email", { exact: true })
    .fill(secret("TEST_ACCOUNT_EMAIL"));
  await page
    .getByRole("button", { name: "Send a sign-in link", exact: true })
    .click();
  await expect(page.locator("#notice")).toContainText("Check your email");
  const delivered = await inbox.waitForLogin(m, sentAt);
  page.once("dialog", async (dialog) => {
    if (
      dialog.type() === "confirm" &&
      dialog.message() === "Sign in to Your Agent using this email link?"
    )
      await dialog.accept();
    else await dialog.dismiss();
  });
  await page.goto(delivered.url);
  await expect(page.locator("#account")).toBeVisible();
  await expect(page.locator("#mode")).toHaveValue(m.mode);
  expect(new URL(page.url()).hash).toBe("");
  const cookie = (await context.cookies(m.origin)).find(
    (c) => c.name === "__Host-session",
  );
  expect(cookie).toMatchObject({
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    domain: new URL(m.origin).hostname,
  });
  // Replay through the public API; the consumed token cannot issue another session.
  const replay = await page.request.post(`${m.origin}/api/auth/consume`, {
    headers: { origin: m.origin },
    data: {
      token: new URLSearchParams(new URL(delivered.url).hash.slice(1)).get(
        "login",
      ),
    },
  });
  expect(replay.status()).toBe(401);
  await evidence(info, "email", {
    received: true,
    deliveryMs: delivered.deliveryMs,
    modePreserved: true,
    singleUse: true,
    hostCookie: true,
  });
  if (m.mode === "credits")
    await page.locator("#model").selectOption(m.modelId);
  await page
    .getByRole("button", { name: "Continue to secure checkout", exact: true })
    .click();
  await payCheckout(page, "hosting");
  await expect(page).toHaveURL(`${m.origin}/?checkout=returned`, {
    timeout: 60000,
  });
  await page.reload();
  await expect(async () => {
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Open my agent", exact: true }),
    ).toBeEnabled();
  }).toPass({ timeout: 12 * 60000, intervals: [10000] });
  const rows = await sql(
    m,
    "SELECT id,provider_id,provider_hostname,hostname,disk_ids,mode,subscription_id,bootstrap_ready FROM tenants WHERE state<>'deleted'",
  );
  expect(rows).toHaveLength(1);
  const tenant = rows[0];
  expect(tenant.mode).toBe(m.mode);
  expect(tenant.bootstrap_ready).toBe(true);
  expect(tenant.provider_hostname).toBe(`a-${tenant.id}.${m.tenantDomain}`);
  const provider = await cloud().details(tenant.provider_id);
  assertEncryptedStorage(provider);
  expect(provider.hostname).toBe(tenant.provider_hostname);
  const owned = (await cloud().list()).filter((s) =>
    s.hostname.endsWith(`.${m.tenantDomain}`),
  );
  expect(owned).toHaveLength(1);
  const subscription = await stripe.subscriptions.retrieve(
    tenant.subscription_id,
  );
  expect(subscription.livemode).toBe(false);
  const invoices = await stripe.invoices.list({
    subscription: subscription.id,
    status: "paid",
  });
  expect(invoices.data.length).toBeGreaterThan(0);
  const events = await sql(
    m,
    "SELECT e.id,e.type,j.done_at FROM stripe_events e JOIN jobs j ON j.key='stripe:'||e.id WHERE e.object_id=$1",
    [invoices.data[0].id],
  );
  expect(events.some((e) => e.type === "invoice.paid" && e.done_at)).toBe(true);
  await evidence(info, "provisioning", {
    tenantId: tenant.id,
    providerId: provider.uuid,
    providerHostname: provider.hostname,
    hostname: tenant.hostname,
    encryptedDisks: provider.storage_devices.storage_device.map((d: any) => ({
      id: d.storage,
      encrypted: d.storage_encrypted,
    })),
    invoiceIds: invoices.data.map((i) => i.id),
    webhookEvents: events,
    subscriptionId: subscription.id,
    elapsedMs: Date.now() - sentAt,
    exactlyOneTenant: true,
  });
  await portalScreenshot(page, info);
  if (m.mode === "credits") {
    await page
      .getByRole("button", { name: "Buy €10 credit", exact: true })
      .click();
    await payCheckout(page, "credits");
    await expect(page).toHaveURL(`${m.origin}/?checkout=returned`, {
      timeout: 60000,
    });
    await expect(async () => {
      const me = await page.request.get(`${m.origin}/api/me`);
      expect((await me.json()).wallet.balance).toBe("10000000");
    }).toPass({ timeout: 60000 });
    const topups = await sql(
      m,
      "SELECT source,amount FROM ledger WHERE kind='topup'",
    );
    expect(topups).toHaveLength(1);
    expect(topups[0].amount).toBe("10000000");
    await evidence(info, "credit-purchase", topups);
  }
  await page
    .getByRole("button", { name: "Open my agent", exact: true })
    .click();
  await expect(page).toHaveURL(`https://${tenant.hostname}/setup`);
  const agentCookie = (await context.cookies(page.url())).find(
    (c) => c.name === "__Host-agent_session",
  );
  expect(agentCookie).toMatchObject({
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    domain: tenant.hostname,
  });
  const terminal = await context.newPage();
  const wizard = await completeWizard(terminal, page, m);
  await evidence(info, "wizard", wizard);
  const dashboard = await context.newPage(),
    stream = observeGateway(dashboard, m.marker);
  await connectDashboard(page, dashboard);
  const word = `violet-${randomBytes(5).toString("hex")}`;
  await sendChat(
    dashboard,
    `For this test remember the code ${word}. Reply with only "remembered". Do not use tools yet.`,
    stream,
  );
  await sendChat(
    dashboard,
    "What exact code did I ask you to remember? Reply with the code only.",
    stream,
  );
  expect(stream.lastAssistantText.trim()).toBe(word);
  expect(stream.deltas).toBeGreaterThan(0);
  await sendChat(
    dashboard,
    `Use your browser tool to open ${m.markerUrl} and read the marker displayed on that page. Reply with that marker. Do not use web_fetch, curl, exec, or shell tools.`,
    stream,
  );
  expect(stream.browserStarts).toBeGreaterThan(0);
  expect(stream.browserResults).toBeGreaterThan(0);
  expect(stream.markerInBrowserResult).toBe(true);
  await expect(
    dashboard.locator(".chat-bubble").filter({ hasText: m.marker }).last(),
  ).toBeVisible();
  await dashboard.reload();
  await expect(
    dashboard.locator(".chat-bubble").filter({ hasText: m.marker }).last(),
  ).toBeVisible();
  await expect(
    dashboard.locator(".chat-bubble").filter({ hasText: word }).last(),
  ).toBeVisible();
  await evidence(info, "conversation", {
    deltas: stream.deltas,
    finals: stream.finals,
    browserStarts: stream.browserStarts,
    browserResults: stream.browserResults,
    markerInBrowserResult: stream.markerInBrowserResult,
    contextualFollowup: true,
    persistedAfterReload: true,
    marker: m.marker,
    model: m.model,
  });
  // Fresh contexts cannot access owner routes; foreign-origin owner mutations fail.
  const foreign = await page.request.post(
    `https://${tenant.hostname}/api/local/pair`,
    {
      headers: { origin: "https://foreign.invalid" },
      data: { requestId: "wrong", publicKey: "wrong" },
    },
  );
  expect(foreign.status()).toBe(403);
  const unauthorized = await page.request.get(
    `https://${tenant.hostname}/internal/status`,
  );
  expect(unauthorized.status()).toBe(401);
  await evidence(info, "access", {
    portalHostCookie: true,
    tenantHostCookie: true,
    foreignOriginRejected: true,
    unauthorizedManagementRejected: true,
    sameOriginTerminalSocket: true,
  });
  if (m.mode === "credits") {
    await expect(async () => {
      const pending = await sql(
        m,
        "SELECT count(*)::int AS count FROM requests WHERE state<>'settled'",
      );
      expect(pending[0].count).toBe(0);
    }).toPass({ timeout: 60000 });
    const usage = await sql(
      m,
      "SELECT r.id,r.state,r.rate_version,r.rates,r.usage,r.charged,(SELECT count(*)::int FROM ledger l WHERE l.source='request:'||r.id) AS settlements FROM requests r",
    );
    expect(usage.length).toBeGreaterThan(0);
    for (const row of usage) {
      expect(row.settlements).toBe(1);
      expect(row.rate_version).toBe(m.runId);
      expect(row.rates).toBeTruthy();
      const u = row.usage,
        r = row.rates,
        cached = u.prompt_tokens_details?.cached_tokens ?? 0;
      const numerator =
        (BigInt(u.prompt_tokens - cached) * BigInt(r.inputMicroEurPerMillion) +
          BigInt(cached) * BigInt(r.cachedMicroEurPerMillion) +
          BigInt(u.completion_tokens) * BigInt(r.outputMicroEurPerMillion)) *
        125n;
      expect(row.charged).toBe(
        ((numerator + 100000000n - 1n) / 100000000n).toString(),
      );
    }
    await evidence(info, "managed-settlements", usage);
  }
});
