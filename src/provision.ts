import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { transaction, type DB, incident } from "./db.js";
import { hash, token, seal, unseal } from "./crypto.js";
import type { Config, Model } from "./config.js";
import {
  UpCloud,
  createRejected,
  assertEncryptedStorage,
} from "./providers/upcloud.js";
import { DNS } from "./providers/dns.js";
export function imagePin(image: string) {
  return /^ghcr\.io\/[a-z0-9/._-]+:[a-zA-Z0-9._-]+@sha256:[a-f0-9]{64}$/.test(
    image,
  );
}
export async function tenantCall(
  c: Config,
  t: any,
  path: string,
  body?: unknown,
) {
  const response = await fetch(`https://${t.hostname}/internal/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${unseal(t.management_cipher, c.ENCRYPTION_KEY)}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(
      path === "backup"
        ? 300000
        : ["suspend", "resume"].includes(path)
          ? 180000
          : 20000,
    ),
  });
  if (!response.ok) throw Error(`TENANT_${response.status}`);
  return response;
}
export class Provisioner {
  constructor(
    readonly db: DB,
    readonly c: Config,
    readonly catalog: Model[],
    readonly cloud = new UpCloud(c),
    readonly dns = new DNS(c),
  ) {}
  async provision(id: string) {
    const conn = await this.db.connect();
    let locked = false;
    try {
      locked = (
        await conn.query(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
          [id],
        )
      ).rows[0].locked;
      if (!locked) throw Error("TENANT_BUSY");
      let t = (await conn.query("SELECT * FROM tenants WHERE id=$1", [id]))
        .rows[0];
      if (
        !t ||
        ["deleted", "deleting", "suspended", "pending_payment"].includes(
          t.state,
        )
      )
        return;
      if (!(
        new Date(t.paid_until).getTime() > Date.now() ||
        new Date(t.grace_until).getTime() > Date.now()
      ))
        throw Error("ENTITLEMENT_EXPIRED");
      if (
        !imagePin(this.c.OPENCLAW_IMAGE) ||
        !this.c.OPENCLAW_IMAGE.startsWith("ghcr.io/openclaw/openclaw:") ||
        !imagePin(this.c.TENANT_IMAGE)
      )
        throw Error("PINNED_IMAGES_REQUIRED");
      if (
        !this.c.UPCLOUD_TOKEN ||
        !this.c.UPCLOUD_PLAN ||
        !this.c.UPCLOUD_TEMPLATE ||
        !this.c.ADMIN_CIDR ||
        !this.c.ADMIN_SSH_PUBLIC_KEY
      )
        throw Error("PROVISIONING_CONFIG_MISSING");
      let remote = t.provider_id
        ? await this.cloud.details(t.provider_id)
        : await this.cloud.find(t.hostname);
      if (!remote) {
        // Persist the attempt BEFORE the network request. An uncertain request is never blindly repeated.
        if (t.create_attempted_at) {
          await incident(
            conn,
            `ambiguous:${id}`,
            "provider_create_ambiguous",
            id,
          );
          throw Error("CREATE_REQUIRES_RECONCILIATION");
        }
        const bootstrap = token(),
          gateway = token(),
          apiKey = t.mode === "credits" ? token() : undefined;
        const bundle = {
          tenantId: id,
          hostname: t.hostname,
          controlOrigin: this.c.PUBLIC_ORIGIN,
          publicKey: this.c.publicKey,
          managementKey: unseal(t.management_cipher, this.c.ENCRYPTION_KEY),
          gatewayToken: gateway,
          openclawImage: this.c.OPENCLAW_IMAGE,
          tenantImage: this.c.TENANT_IMAGE,
          adminCidr: this.c.ADMIN_CIDR,
          backupRecipient: this.c.BACKUP_AGE_RECIPIENT,
          mode: t.mode,
          inferenceKey: apiKey,
          model:
            this.catalog.find((m) => m.id === t.model_id) &&
            JSON.parse(
              JSON.stringify(
                this.catalog.find((m) => m.id === t.model_id),
                (_, v) => (typeof v === "bigint" ? v.toString() : v),
              ),
            ),
        };
        const userdata = await readFile("deploy/cloud-init.sh", "utf8");
        const inject = {
          CONTROL_ORIGIN: this.c.PUBLIC_ORIGIN,
          TENANT_ID: id,
          BOOTSTRAP_TOKEN: bootstrap,
        };
        const header = Object.entries(inject)
          .map(([k, v]) => `${k}='${v.replaceAll("'", "'\\''")}'`)
          .join("\n");
        await conn.query(
          "UPDATE tenants SET create_attempted_at=now(),bootstrap_hash=$2,bootstrap_expires_at=now()+interval '30 minutes',bundle_cipher=$3,inference_key_hash=$4,inference_key_cipher=$5,state='provisioning' WHERE id=$1",
          [
            id,
            hash(bootstrap),
            seal(JSON.stringify(bundle), this.c.ENCRYPTION_KEY),
            apiKey ? hash(apiKey) : null,
            apiKey ? seal(apiKey, this.c.ENCRYPTION_KEY) : null,
          ],
        );
        try {
          remote = await this.cloud.create(
            t.hostname,
            id,
            userdata.replace("# BOOTSTRAP_VARIABLES", header),
          );
        } catch (e: any) {
          if (createRejected(e))
            await conn.query(
              "UPDATE tenants SET create_attempted_at=NULL,bootstrap_hash=NULL,bootstrap_expires_at=NULL,bundle_cipher=NULL,inference_key_hash=NULL,inference_key_cipher=NULL WHERE id=$1",
              [id],
            );
          throw e;
        }
      }
      remote = await this.cloud.details(remote.uuid);
      if (remote.hostname !== t.hostname)
        throw Error("PROVIDER_OWNERSHIP_MISMATCH");
      const ip = remote.ip_addresses?.ip_address?.find(
        (x: any) => x.access === "public" && x.family === "IPv4",
      )?.address;
      const disks = (remote.storage_devices?.storage_device ?? []).map(
        (x: any) => x.storage,
      );
      await conn.query(
        "UPDATE tenants SET provider_id=$2,ip=$3,disk_ids=$4 WHERE id=$1",
        [id, remote.uuid, ip ?? null, JSON.stringify(disks)],
      );
      // Retain resource IDs for reconciliation/cleanup even when verification fails.
      // Check both newly created and adopted VMs before DNS or customer setup.
      assertEncryptedStorage(remote);
      if (!ip) throw Error("WAITING_FOR_PUBLIC_IP");
      const dnsId = await this.dns.ensure(t.hostname, ip);
      await conn.query("UPDATE tenants SET dns_id=$2 WHERE id=$1", [id, dnsId]);
      t = (await conn.query("SELECT * FROM tenants WHERE id=$1", [id])).rows[0];
      const health: any = await (await tenantCall(this.c, t, "status")).json();
      if (!health.installed) throw Error("WAITING_FOR_BOOTSTRAP");
      if (t.mode === "credits") {
        if (!this.catalog.find((m) => m.id === t.model_id)?.verified)
          throw Error("MODEL_NOT_VERIFIED");
        await tenantCall(this.c, t, "prepaid", {});
      }
      await conn.query(
        "UPDATE tenants SET state='awaiting_setup',error_code=NULL,bundle_cipher=NULL WHERE id=$1",
        [id],
      );
    } finally {
      if (locked)
        await conn.query("SELECT pg_advisory_unlock(hashtext($1))", [id]);
      conn.release();
    }
  }
}
