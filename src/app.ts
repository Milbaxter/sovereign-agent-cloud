import Fastify, { LogController } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { resolve } from "node:path";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type Config,
  type Model,
  launchGate,
  checkoutAvailable,
} from "./config.js";
import { type DB, transaction, audit } from "./db.js";
import { auth, identity } from "./auth.js";
import { hash, seal, unseal, token, handoff } from "./crypto.js";
import { Billing } from "./billing.js";
import { inference } from "./inference.js";
import { tenantCall } from "./provision.js";
import { contentRoutes } from "./content/routes.js";
export async function buildApp(
  c: Config,
  db: DB,
  catalog: Model[],
  billing = new Billing(db, c),
) {
  const app = Fastify({
    logger: {
      level: "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
        "req.body",
      ],
    },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1_000_000,
    // API is exposed only through Caddy and a loopback host port; trust that one hop.
    trustProxy: (_address: string, hop: number) => hop === 0,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("cache-control", "no-store")
      .header("x-robots-tag", "noindex,nofollow")
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff");
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https:",
    );
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      !req.url.startsWith("/v1/") &&
      !req.url.startsWith("/webhooks/") &&
      !req.url.startsWith("/bootstrap/")
    ) {
      if (req.headers.origin !== c.PUBLIC_ORIGIN)
        throw Object.assign(Error("ORIGIN_REJECTED"), { statusCode: 403 });
    }
  });
  app.setErrorHandler((error: any, _req, reply) => {
    const status =
      error instanceof z.ZodError ? 400 : (error.statusCode ?? 500);
    if (status >= 500)
      app.log.error(
        {
          code: /^[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : "INTERNAL_ERROR",
        },
        "request failed",
      );
    reply.code(status).send({
      error:
        status >= 500
          ? "SERVICE_UNAVAILABLE"
          : error instanceof z.ZodError
            ? "INVALID_REQUEST"
            : error.message,
    });
  });
  app.get("/healthz", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });
  auth(app, db, c);
  inference(app, db, catalog);
  app.register(
    async (hook) => {
      hook.removeContentTypeParser("application/json");
      hook.addContentTypeParser(
        "application/json",
        { parseAs: "buffer" },
        async (_req: any, body: any) => body,
      );
      hook.post("/stripe", async (req, reply) => {
        try {
          await billing.receive(
            req.body as Buffer,
            String(req.headers["stripe-signature"] ?? ""),
          );
        } catch (e: any) {
          if (e.type === "StripeSignatureVerificationError")
            return reply.code(400).send({ error: "INVALID_SIGNATURE" });
          throw e;
        }
        return { received: true };
      });
    },
    { prefix: "/webhooks" },
  );
  app.post("/bootstrap/:id", async (req) => {
    const id = z
        .string()
        .uuid()
        .parse((req.params as any).id),
      secret = z.object({ token: z.string() }).parse(req.body).token;
    return transaction(db, async (tx) => {
      const row = (
        await tx.query(
          "UPDATE tenants SET bootstrap_hash=NULL WHERE id=$1 AND bootstrap_hash=$2 AND bootstrap_expires_at>now() RETURNING bundle_cipher",
          [id, hash(secret)],
        )
      ).rows[0];
      if (!row)
        throw Object.assign(Error("BOOTSTRAP_EXPIRED"), { statusCode: 403 });
      return JSON.parse(unseal(row.bundle_cipher, c.ENCRYPTION_KEY));
    });
  });
  app.get("/api/catalog", async () => ({
    hostingMonthlyCents: 2500,
    creditTopupCents: 1000,
    checkoutEnabled: checkoutAvailable(c),
    creditsEnabled:
      checkoutAvailable(c, true) && catalog.some((m) => m.verified),
    billingMode: c.BILLING_MODE,
    models: catalog
      .filter((m) => m.verified)
      .map((m) => ({
        id: m.id,
        label: m.label,
        provider: m.provider,
        country: m.country,
        rateVersion: m.rateVersion,
        inputEuroPerMillion: (Number(m.inputMicroEurPerMillion) * 1.25) / 1e6,
        cachedEuroPerMillion: (Number(m.cachedMicroEurPerMillion) * 1.25) / 1e6,
        outputEuroPerMillion: (Number(m.outputMicroEurPerMillion) * 1.25) / 1e6,
      })),
  }));
  app.get("/api/me", async (req) => {
    const who = await identity(req, db),
      account = (
        await db.query("SELECT email FROM accounts WHERE id=$1", [
          who.accountId,
        ])
      ).rows[0];
    const tenants = (
      await db.query(
        "SELECT id,mode,model_id,state,hostname,paid_until,cancel_at_period_end,delete_after,error_code FROM tenants WHERE account_id=$1 AND state<>'deleted'",
        [who.accountId],
      )
    ).rows;
    const wallet = (
      await db.query(
        "SELECT balance,reserved,debt FROM wallets WHERE account_id=$1",
        [who.accountId],
      )
    ).rows[0] ?? { balance: "0", reserved: "0", debt: "0" };
    return { email: account.email, tenants, wallet };
  });
  app.post("/api/checkout", async (req) => {
    const who = await identity(req, db),
      body = z
        .object({
          mode: z.enum(["byok", "credits"]),
          modelId: z.string().optional(),
        })
        .parse(req.body);
    launchGate(c, body.mode === "credits");
    if (
      body.mode === "credits" &&
      !catalog.some((m) => m.id === body.modelId && m.verified)
    )
      throw Object.assign(Error("SELECT_VERIFIED_MODEL"), { statusCode: 400 });
    const order = await transaction(db, async (tx) => {
      await tx.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
        who.accountId,
      ]);
      let tenant = (
        await tx.query(
          "SELECT * FROM tenants WHERE account_id=$1 AND state<>'deleted'",
          [who.accountId],
        )
      ).rows[0];
      if (tenant && tenant.state !== "pending_payment")
        throw Object.assign(Error("ALREADY_SUBSCRIBED"), { statusCode: 409 });
      if (!tenant) {
        await tx.query("SELECT pg_advisory_xact_lock(582200)");
        // Paid founders keep their place after cancellation/deletion. Unpaid
        // reservations count only until maintenance expires the abandoned tenant.
        const cohort = (
          await tx.query(
            "SELECT count(DISTINCT account_id) AS count, bool_or(account_id=$1) AS returning FROM tenants WHERE state<>'deleted' OR EXISTS(SELECT 1 FROM orders WHERE tenant_id=tenants.id AND kind='hosting' AND state='paid')",
            [who.accountId],
          )
        ).rows[0];
        if (!cohort.returning && Number(cohort.count) >= c.MAX_TENANTS)
          throw Object.assign(Error("COHORT_FULL"), { statusCode: 409 });
        const id = randomUUID();
        tenant = (
          await tx.query(
            "INSERT INTO tenants(id,account_id,mode,model_id,hostname,management_cipher) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [
              id,
              who.accountId,
              body.mode,
              body.modelId ?? null,
              `a-${id}.${c.TENANT_DOMAIN}`,
              seal(token(), c.ENCRYPTION_KEY),
            ],
          )
        ).rows[0];
      }
      // Freeze inference consent while an existing checkout may still be paid.
      if (
        tenant.mode !== body.mode ||
        tenant.model_id !== (body.modelId ?? null)
      )
        throw Object.assign(Error("CHECKOUT_SELECTION_ALREADY_SAVED"), {
          statusCode: 409,
        });
      let order = (
        await tx.query(
          "SELECT * FROM orders WHERE tenant_id=$1 AND kind='hosting' AND state='pending' ORDER BY created_at DESC LIMIT 1",
          [tenant.id],
        )
      ).rows[0];
      if (!order)
        order = (
          await tx.query(
            "INSERT INTO orders(id,account_id,tenant_id,kind,mode,amount_cents) VALUES($1,$2,$3,'hosting',$4,2500) RETURNING *",
            [randomUUID(), who.accountId, tenant.id, c.BILLING_MODE],
          )
        ).rows[0];
      return order;
    });
    return checkoutFor(order);
  });
  async function checkoutFor(order: any) {
    let account = (
      await db.query("SELECT * FROM accounts WHERE id=$1", [order.account_id])
    ).rows[0];
    if (!account.stripe_customer) {
      const customer = await billing.stripe.customers.create(
        { email: account.email, metadata: { account_id: account.id } },
        { idempotencyKey: `customer:${c.BILLING_MODE}:${account.id}` },
      );
      await db.query("UPDATE accounts SET stripe_customer=$2 WHERE id=$1", [
        account.id,
        customer.id,
      ]);
      account.stripe_customer = customer.id;
    }
    if (order.checkout_id) {
      const existing = await billing.stripe.checkout.sessions.retrieve(
        order.checkout_id,
      );
      if (existing.status === "open") return { url: existing.url };
      if (existing.status === "complete")
        throw Object.assign(Error("PAYMENT_PROCESSING"), { statusCode: 409 });
      order = await transaction(db, async (tx) => {
        await tx.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE", [
          order.id,
        ]);
        const next = (
          await tx.query(
            "SELECT * FROM orders WHERE tenant_id=$1 AND kind=$2 AND state='pending' AND id<>$3 ORDER BY created_at DESC LIMIT 1",
            [order.tenant_id, order.kind, order.id],
          )
        ).rows[0];
        if (next) return next;
        await tx.query("UPDATE orders SET state='expired' WHERE id=$1", [
          order.id,
        ]);
        return (
          await tx.query(
            "INSERT INTO orders(id,account_id,tenant_id,kind,mode,amount_cents) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [
              randomUUID(),
              order.account_id,
              order.tenant_id,
              order.kind,
              order.mode,
              order.amount_cents,
            ],
          )
        ).rows[0];
      });
      return checkoutFor(order);
    }
    const session = await billing.checkout(order, account.stripe_customer);
    await db.query("UPDATE orders SET checkout_id=$2 WHERE id=$1", [
      order.id,
      session.id,
    ]);
    return { url: session.url };
  }
  app.post("/api/credits/checkout", async (req) => {
    const who = await identity(req, db);
    launchGate(c, true);
    const t = (
      await db.query(
        "SELECT * FROM tenants WHERE account_id=$1 AND mode='credits' AND state IN ('ready','awaiting_setup') AND (paid_until>now() OR grace_until>now())",
        [who.accountId],
      )
    ).rows[0];
    if (!t)
      throw Object.assign(Error("ACTIVE_CREDIT_AGENT_REQUIRED"), {
        statusCode: 409,
      });
    const order = (
      await db.query(
        "INSERT INTO orders(id,account_id,tenant_id,kind,mode,amount_cents) VALUES($1,$2,$3,'credits',$4,1000) RETURNING *",
        [randomUUID(), who.accountId, t.id, c.BILLING_MODE],
      )
    ).rows[0];
    return checkoutFor(order);
  });
  app.get("/api/credits/ledger", async (req) => {
    const who = await identity(req, db);
    return (
      await db.query(
        "SELECT amount,kind,metadata,created_at FROM ledger WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100",
        [who.accountId],
      )
    ).rows;
  });
  async function owned(req: any, fresh = false) {
    const who = await identity(req, db, fresh),
      id = z.string().uuid().parse(req.params.id);
    const t = (
      await db.query(
        "SELECT * FROM tenants WHERE id=$1 AND account_id=$2 AND state<>'deleted'",
        [id, who.accountId],
      )
    ).rows[0];
    if (!t) throw Object.assign(Error("NOT_FOUND"), { statusCode: 404 });
    return t;
  }
  app.post("/api/tenants/:id/access", async (req) => {
    const t = await owned(req);
    if (
      !["awaiting_setup", "ready"].includes(t.state) ||
      !(
        new Date(t.paid_until).getTime() > Date.now() ||
        new Date(t.grace_until).getTime() > Date.now()
      )
    )
      throw Object.assign(Error("AGENT_NOT_READY"), { statusCode: 409 });
    await audit(db, t.account_id, t.id, "access");
    return {
      url: `https://${t.hostname}/handoff#ticket=${await handoff(c.privateKey, t.id, `https://${t.hostname}`)}`,
    };
  });
  app.post("/api/tenants/:id/export", async (req) => {
    const t = await owned(req, true),
      { recipient } = z
        .object({ recipient: z.string().regex(/^age1[0-9a-z]{58}$/) })
        .parse(req.body);
    if (!["awaiting_setup", "ready", "suspended"].includes(t.state))
      throw Object.assign(Error("EXPORT_UNAVAILABLE"), { statusCode: 409 });
    await audit(db, t.account_id, t.id, "export");
    return {
      url: `https://${t.hostname}/handoff#ticket=${await handoff(c.privateKey, t.id, `https://${t.hostname}`, "export", recipient)}`,
    };
  });
  app.post("/api/tenants/:id/ssh-key", async (req) => {
    const t = await owned(req, true),
      { publicKey, sourceIp } = z
        .object({
          publicKey: z
            .string()
            .max(1000)
            .regex(/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}(?: [^\r\n]+)?$/),
          sourceIp: z.string().refine((v) => isIP(v) === 4),
        })
        .parse(req.body);
    await tenantCall(c, t, "ssh-key", { publicKey, sourceIp });
    await audit(db, t.account_id, t.id, "ssh_key_added");
    return { ok: true };
  });
  app.post("/api/billing/portal", async (req) => {
    const who = await identity(req, db);
    const a = (
      await db.query("SELECT stripe_customer FROM accounts WHERE id=$1", [
        who.accountId,
      ])
    ).rows[0];
    if (!a.stripe_customer)
      throw Object.assign(Error("NO_BILLING_ACCOUNT"), { statusCode: 409 });
    return {
      url: (
        await billing.stripe.billingPortal.sessions.create({
          customer: a.stripe_customer,
          return_url: c.PUBLIC_ORIGIN,
        })
      ).url,
    };
  });
  app.post("/api/tenants/:id/cancel", async (req) => {
    const t = await owned(req, true);
    if (!t.subscription_id)
      throw Object.assign(Error("NO_SUBSCRIPTION"), { statusCode: 409 });
    await billing.stripe.subscriptions.update(t.subscription_id, {
      cancel_at_period_end: true,
    });
    await billing.subscription(t.subscription_id);
    await audit(db, t.account_id, t.id, "cancel_at_period_end");
    return { ok: true };
  });
  contentRoutes(app, c);
  await app.register(staticFiles, { root: resolve("public") });
  return app;
}
