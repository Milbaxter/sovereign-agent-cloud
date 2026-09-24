import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { transaction, enqueue, incident, type DB } from "./db.js";
import { credit, reverseCredit } from "./ledger.js";
import type { Config } from "./config.js";
export const EVENT_TYPES = new Set([
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
]);
export class Billing {
  stripe: Stripe;
  constructor(
    readonly db: DB,
    readonly c: Config,
    stripe?: Stripe,
  ) {
    this.stripe =
      stripe ??
      new Stripe(c.STRIPE_SECRET_KEY || "sk_test_unconfigured", {
        maxNetworkRetries: 2,
      });
  }
  async receive(raw: Buffer, signature: string) {
    const event = this.stripe.webhooks.constructEvent(
      raw,
      signature,
      this.c.STRIPE_WEBHOOK_SECRET,
    );
    if (event.livemode !== (this.c.BILLING_MODE === "live"))
      throw Object.assign(Error("WRONG_BILLING_MODE"), { statusCode: 400 });
    if (!EVENT_TYPES.has(event.type)) return;
    await transaction(this.db, async (tx) => {
      const object = event.data.object as any;
      const inserted = await tx.query(
        "INSERT INTO stripe_events(id,type,mode,object_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id",
        [event.id, event.type, this.c.BILLING_MODE, object.id],
      );
      if (inserted.rowCount)
        await enqueue(tx, `stripe:${event.id}`, "stripe", {
          type: event.type,
          id: object.id,
        });
    });
  }
  async checkout(order: any, customer: string) {
    const hosting = order.kind === "hosting",
      price = hosting
        ? this.c.STRIPE_HOSTING_PRICE_ID
        : this.c.STRIPE_CREDIT_PRICE_ID;
    const actual = await this.stripe.prices.retrieve(price);
    if (
      actual.currency !== "eur" ||
      actual.unit_amount !== (hosting ? 2500 : 1000) ||
      actual.tax_behavior !== "exclusive" ||
      (hosting
        ? actual.recurring?.interval !== "month" ||
          actual.recurring.interval_count !== 1
        : !!actual.recurring)
    )
      throw Error("PRICE_CONFIGURATION_MISMATCH");
    const metadata = {
      order_id: order.id,
      account_id: order.account_id,
      tenant_id: order.tenant_id ?? "",
      billing_mode: this.c.BILLING_MODE,
    };
    return this.stripe.checkout.sessions.create(
      {
        mode: hosting ? "subscription" : "payment",
        customer,
        line_items: [{ price, quantity: 1 }],
        client_reference_id: order.account_id,
        metadata,
        ...(hosting
          ? { subscription_data: { metadata } }
          : { payment_intent_data: { metadata } }),
        automatic_tax: { enabled: this.c.STRIPE_AUTOMATIC_TAX },
        customer_update: { address: "auto" },
        success_url: `${this.c.PUBLIC_ORIGIN}/?checkout=returned`,
        cancel_url: `${this.c.PUBLIC_ORIGIN}/`,
        expires_at: Math.floor(Date.now() / 1000) + 1800,
      },
      { idempotencyKey: `checkout:${order.id}` },
    );
  }
  async handle(type: string, id: string) {
    if (type.startsWith("checkout.session.")) return this.checkoutPaid(id);
    if (type.startsWith("invoice.")) {
      const invoice: any = await this.stripe.invoices.retrieve(id);
      const sub =
        invoice.parent?.subscription_details?.subscription ??
        invoice.subscription;
      if (sub) await this.subscription(typeof sub === "string" ? sub : sub.id);
      return;
    }
    if (type.startsWith("customer.subscription.")) return this.subscription(id);
    if (type === "charge.refunded") return this.reversal(id);
    if (type.startsWith("charge.dispute.")) {
      const dispute = await this.stripe.disputes.retrieve(id);
      return this.reversal(
        typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id,
      );
    }
  }
  async checkoutPaid(id: string) {
    const session = await this.stripe.checkout.sessions.retrieve(id, {
      expand: ["line_items"],
    });
    if (
      session.livemode !== (this.c.BILLING_MODE === "live") ||
      session.payment_status !== "paid"
    )
      return;
    const order = (
      await this.db.query(
        "SELECT o.*,a.stripe_customer FROM orders o JOIN accounts a ON a.id=o.account_id WHERE o.id=$1",
        [session.metadata?.order_id],
      )
    ).rows[0];
    if (
      !order ||
      session.customer !== order.stripe_customer ||
      session.metadata?.account_id !== order.account_id ||
      order.mode !== this.c.BILLING_MODE
    )
      throw Error("ORDER_BINDING_MISMATCH");
    if (order.kind === "hosting") {
      if (session.subscription)
        await this.subscription(
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id,
        );
      return;
    }
    const items = session.line_items?.data;
    if (
      session.mode !== "payment" ||
      session.currency !== "eur" ||
      session.amount_subtotal !== 1000 ||
      items?.length !== 1 ||
      items[0].price?.id !== this.c.STRIPE_CREDIT_PRICE_ID ||
      items[0].quantity !== 1
    )
      throw Error("CREDIT_PAYMENT_MISMATCH");
    const pi =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;
    if (!pi) throw Error("MISSING_PAYMENT_INTENT");
    await transaction(this.db, async (tx) => {
      await tx.query("SELECT 1 FROM orders WHERE id=$1 FOR UPDATE", [order.id]);
      await credit(tx, order.account_id, `checkout:${session.id}`, 10_000_000n);
      await tx.query(
        "UPDATE orders SET state='paid',checkout_id=$2,payment_intent=$3 WHERE id=$1",
        [order.id, session.id, pi],
      );
    });
    const payment = await this.stripe.paymentIntents.retrieve(pi);
    if (payment.latest_charge)
      await this.reversal(
        typeof payment.latest_charge === "string"
          ? payment.latest_charge
          : payment.latest_charge.id,
      );
  }
  async subscription(id: string) {
    const lock = await this.db.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtext($1))", [
        `subscription:${id}`,
      ]);
      return await this.reconcileSubscription(id);
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [
        `subscription:${id}`,
      ]);
      lock.release();
    }
  }
  private async reconcileSubscription(id: string) {
    const sub: any = await this.stripe.subscriptions.retrieve(id);
    if (sub.livemode !== (this.c.BILLING_MODE === "live"))
      throw Error("WRONG_BILLING_MODE");
    const order = (
      await this.db.query(
        "SELECT o.*,a.stripe_customer FROM orders o JOIN accounts a ON a.id=o.account_id WHERE o.id=$1 AND o.kind='hosting'",
        [sub.metadata?.order_id],
      )
    ).rows[0];
    if (
      !order ||
      sub.customer !== order.stripe_customer ||
      sub.metadata?.account_id !== order.account_id ||
      order.mode !== this.c.BILLING_MODE
    )
      throw Error("SUBSCRIPTION_BINDING_MISMATCH");
    const invoices = await this.stripe.invoices.list({
      subscription: id,
      status: "paid",
      limit: 100,
    });
    let paidUntil = 0;
    for (const invoice of invoices.data) {
      if (invoice.status !== "paid") continue;
      for (const line of invoice.lines.data as any[]) {
        if (
          (line.pricing?.price_details?.price ?? line.price?.id) ===
            this.c.STRIPE_HOSTING_PRICE_ID &&
          line.quantity === 1 &&
          line.amount >= 2500
        )
          paidUntil = Math.max(paidUntil, line.period.end);
      }
    }
    if (sub.status === "canceled" && sub.ended_at)
      paidUntil = Math.min(paidUntil, sub.ended_at);
    const entitled = paidUntil * 1000 > Date.now(),
      grace = ["past_due"].includes(sub.status)
        ? new Date(paidUntil * 1000 + 7 * 86400000)
        : null;
    await transaction(this.db, async (tx) => {
      // Serializes reconciliation against other events for this subscription.
      await tx.query("SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE", [
        order.tenant_id,
      ]);
      const existing = (
        await tx.query("SELECT * FROM tenants WHERE id=$1", [order.tenant_id])
      ).rows[0];
      if (existing.subscription_id && existing.subscription_id !== id) {
        await incident(
          tx,
          `duplicate-sub:${id}`,
          "duplicate_subscription",
          order.tenant_id,
        );
        return;
      }
      await tx.query(
        "UPDATE tenants SET subscription_id=$2,paid_until=$3,grace_until=$4,cancel_at_period_end=$5 WHERE id=$1",
        [
          order.tenant_id,
          id,
          paidUntil ? new Date(paidUntil * 1000) : null,
          grace,
          !!sub.cancel_at_period_end,
        ],
      );
      if (entitled || (grace && grace.getTime() > Date.now())) {
        await tx.query("UPDATE orders SET state='paid' WHERE id=$1", [
          order.id,
        ]);
        if (existing.state === "pending_payment")
          await tx.query(
            "UPDATE tenants SET state='provisioning' WHERE id=$1",
            [order.tenant_id],
          );
        if (
          ["pending_payment", "provisioning", "failed"].includes(existing.state)
        )
          await enqueue(tx, `provision:${order.tenant_id}`, "provision", {
            tenantId: order.tenant_id,
          });
        if (existing.state === "suspended")
          await enqueue(
            tx,
            `resume:${order.tenant_id}:${paidUntil}`,
            "resume",
            { tenantId: order.tenant_id },
          );
      }
    });
  }
  async reversal(chargeId: string) {
    const charge = await this.stripe.charges.retrieve(chargeId);
    const pi =
      typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : charge.payment_intent?.id;
    const order = (
      await this.db.query(
        "SELECT * FROM orders WHERE payment_intent=$1 AND kind='credits' AND state='paid'",
        [pi],
      )
    ).rows[0];
    if (!order) return; // Successful checkout rechecks reversals, covering event reordering.
    const disputes = await this.stripe.disputes.list({
      charge: chargeId,
      limit: 100,
    });
    const disputed = disputes.data.some(
      (d) => !["won", "warning_closed"].includes(d.status),
    );
    const target = disputed
      ? 10_000_000n
      : (10_000_000n * BigInt(charge.amount_refunded)) / BigInt(charge.amount);
    await transaction(this.db, (tx) =>
      reverseCredit(tx, order.account_id, order.id, target),
    );
  }
}
