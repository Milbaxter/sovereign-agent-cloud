import { randomUUID } from "node:crypto";
import { type DB, transaction, enqueue, incident } from "./db.js";
import type { Config, Model } from "./config.js";
import { Billing } from "./billing.js";
import { Provisioner, tenantCall } from "./provision.js";
import { Backups } from "./backup.js";
import { releaseUnknown } from "./ledger.js";
export class Worker {
  readonly provisioner: Provisioner;
  readonly billing: Billing;
  readonly backups: Backups;
  constructor(
    readonly db: DB,
    readonly c: Config,
    catalog: Model[],
  ) {
    this.provisioner = new Provisioner(db, c, catalog);
    this.billing = new Billing(db, c);
    this.backups = new Backups(c);
  }
  async tick() {
    const lease = randomUUID();
    const job = await transaction(
      this.db,
      async (tx) =>
        (
          await tx.query(
            "UPDATE jobs SET lease_token=$1,lease_until=now()+interval '10 minutes',attempts=attempts+1 WHERE id=(SELECT id FROM jobs WHERE done_at IS NULL AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) AND attempts<20 ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",
            [lease],
          )
        ).rows[0],
    );
    if (!job) return false;
    const keepalive = setInterval(() => {
      void this.db
        .query(
          "UPDATE jobs SET lease_until=now()+interval '10 minutes' WHERE id=$1 AND lease_token=$2",
          [job.id, lease],
        )
        .catch(() => {});
    }, 60000);
    try {
      await this.handle(job.kind, job.payload);
      await this.db.query(
        "UPDATE jobs SET done_at=now(),lease_until=NULL,error_code=NULL WHERE id=$1 AND lease_token=$2",
        [job.id, lease],
      );
    } catch (e: any) {
      const code = /^[A-Z0-9_]+$/.test(e.message) ? e.message : "JOB_FAILED";
      await this.db.query(
        "UPDATE jobs SET error_code=$3,lease_until=NULL,available_at=now()+$4*interval '1 second' WHERE id=$1 AND lease_token=$2",
        [
          job.id,
          lease,
          code,
          Math.min(1800, 10 * 2 ** Math.min(job.attempts, 8)),
        ],
      );
      if (job.payload.tenantId)
        await this.db.query("UPDATE tenants SET error_code=$2 WHERE id=$1", [
          job.payload.tenantId,
          code,
        ]);
      if (job.attempts >= 5)
        await incident(
          this.db,
          `job:${job.id}`,
          "job_repeated_failure",
          job.payload.tenantId ?? null,
          { kind: job.kind, code },
        );
      if (job.attempts >= 20 && job.kind === "provision")
        await this.db.query(
          "UPDATE tenants SET state='failed' WHERE id=$1 AND state='provisioning'",
          [job.payload.tenantId],
        );
    } finally {
      clearInterval(keepalive);
    }
    return true;
  }
  async handle(kind: string, p: any) {
    if (kind === "stripe") return this.billing.handle(p.type, p.id);
    if (kind === "provision") return this.provisioner.provision(p.tenantId);
    const t = (
      await this.db.query("SELECT * FROM tenants WHERE id=$1", [p.tenantId])
    ).rows[0];
    if (!t || t.state === "deleted") return;
    if (kind === "backup") return this.backups.take(t);
    if (kind === "suspend") {
      if (
        new Date(t.paid_until).getTime() > Date.now() ||
        new Date(t.grace_until).getTime() > Date.now()
      )
        return;
      if (t.state === "suspended") return;
      try {
        await this.backups.take(t);
      } catch {
        await incident(
          this.db,
          `suspend-backup:${t.id}`,
          "final_backup_failed",
          t.id,
        );
      }
      await tenantCall(this.c, t, "suspend", {});
      await this.db.query(
        "UPDATE tenants SET state='suspended',suspended_at=now(),delete_after=now()+interval '30 days' WHERE id=$1",
        [t.id],
      );
      return;
    }
    if (kind === "resume") {
      if (
        t.state !== "suspended" ||
        !(
          new Date(t.paid_until).getTime() > Date.now() ||
          new Date(t.grace_until).getTime() > Date.now()
        )
      )
        return;
      await tenantCall(this.c, t, "resume", {});
      await this.db.query(
        "UPDATE tenants SET state='awaiting_setup',suspended_at=NULL,delete_after=NULL WHERE id=$1",
        [t.id],
      );
      return;
    }
    if (kind === "delete") {
      if (
        new Date(t.delete_after).getTime() > Date.now() ||
        !t.delete_after ||
        !["suspended", "deleting"].includes(t.state)
      )
        return;
      if (
        new Date(t.paid_until).getTime() > Date.now() ||
        new Date(t.grace_until).getTime() > Date.now()
      )
        return;
      await this.db.query(
        "UPDATE tenants SET state='deleting',inference_key_hash=NULL WHERE id=$1",
        [t.id],
      );
      if (t.provider_id)
        await this.provisioner.cloud.destroy(t.provider_id, t.disk_ids);
      if (t.dns_id) await this.provisioner.dns.remove(t.dns_id);
      await this.backups.remove(t);
      await this.db.query(
        "UPDATE tenants SET state='deleted',management_cipher='',inference_key_cipher=NULL,bundle_cipher=NULL,bootstrap_hash=NULL,ip=NULL WHERE id=$1",
        [t.id],
      );
      return;
    }
    throw Error("UNKNOWN_JOB");
  }
  async maintenance() {
    await releaseUnknown(this.db);
    await this.db.query("DELETE FROM login_tokens WHERE expires_at<now()");
    await this.db.query("DELETE FROM sessions WHERE expires_at<now()");
    const abandoned = (
      await this.db.query(
        "SELECT t.*,o.checkout_id,o.id AS order_id FROM tenants t JOIN orders o ON o.tenant_id=t.id WHERE t.state='pending_payment' AND o.state='pending' AND o.created_at<now()-interval '24 hours'",
      )
    ).rows;
    for (const t of abandoned) {
      if (t.checkout_id) {
        const checkout = await this.billing.stripe.checkout.sessions.retrieve(
          t.checkout_id,
        );
        if (checkout.status === "complete") {
          await this.billing.checkoutPaid(t.checkout_id);
          continue;
        }
        if (checkout.status === "open") continue;
      }
      await transaction(this.db, async (tx) => {
        await tx.query("SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE", [t.id]);
        await tx.query(
          "UPDATE orders SET state='expired' WHERE id=$1 AND state='pending'",
          [t.order_id],
        );
        await tx.query(
          "UPDATE tenants SET state='deleted',management_cipher='' WHERE id=$1 AND state='pending_payment' AND NOT EXISTS(SELECT 1 FROM orders WHERE tenant_id=$1 AND state='pending')",
          [t.id],
        );
      });
    }
    const tenants = (
      await this.db.query(
        "SELECT * FROM tenants WHERE state NOT IN ('pending_payment','deleted')",
      )
    ).rows;
    const date = new Date().toISOString().slice(0, 10);
    for (const t of tenants) {
      if (["ready", "awaiting_setup"].includes(t.state)) {
        await enqueue(this.db, `backup:${t.id}:${date}`, "backup", {
          tenantId: t.id,
        });
        if (!(
          new Date(t.paid_until).getTime() > Date.now() ||
          new Date(t.grace_until).getTime() > Date.now()
        ))
          await enqueue(
            this.db,
            `suspend:${t.id}:${new Date(t.paid_until).getTime()}`,
            "suspend",
            { tenantId: t.id },
          );
        try {
          const status: any = await (
            await tenantCall(this.c, t, "status")
          ).json();
          if (status.freeDiskKiB < 2 * 1024 * 1024)
            await incident(this.db, `disk:${t.id}:${date}`, "disk_low", t.id);
          if (status.configured && t.state === "awaiting_setup")
            await this.db.query(
              "UPDATE tenants SET state='ready' WHERE id=$1 AND state='awaiting_setup'",
              [t.id],
            );
        } catch {
          await incident(
            this.db,
            `health:${t.id}:${date}`,
            "tenant_unreachable",
            t.id,
          );
        }
      }
      if (
        ["suspended", "deleting"].includes(t.state) &&
        t.delete_after &&
        new Date(t.delete_after).getTime() <= Date.now()
      )
        await enqueue(this.db, `delete:${t.id}`, "delete", { tenantId: t.id });
    }
  }
}
