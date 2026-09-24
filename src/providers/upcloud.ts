import type { Config } from "../config.js";
export type UpCloudConfig = Pick<
  Config,
  | "UPCLOUD_TOKEN"
  | "UPCLOUD_ZONE"
  | "UPCLOUD_PLAN"
  | "UPCLOUD_TEMPLATE"
  | "ADMIN_SSH_PUBLIC_KEY"
  | "BILLING_MODE"
>;

// Explicit provider rejections are safe to retry after correcting configuration.
// Timeouts, transport failures and 5xx responses remain ambiguous.
export function createRejected(error: { status?: number }) {
  return [400, 401, 402, 403, 404, 409, 422, 429].includes(error.status ?? 0);
}

export class UpCloud {
  constructor(
    readonly c: UpCloudConfig,
    readonly request: typeof fetch = fetch,
  ) {}
  async call(path: string, method = "GET", body?: unknown): Promise<any> {
    if (!this.c.UPCLOUD_TOKEN.trim()) throw Error("UPCLOUD_TOKEN_REQUIRED");
    const res = await this.request(`https://api.upcloud.com/1.3${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.c.UPCLOUD_TOKEN}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const data: any = await res.json().catch(() => null);
      const rawCode = data?.error?.error_code;
      // Never propagate descriptions or response bodies: they can echo inputs.
      const errorCode =
        typeof rawCode === "string" && /^[A-Z0-9_-]{1,100}$/.test(rawCode)
          ? rawCode.replaceAll("-", "_")
          : undefined;
      throw Object.assign(
        Error(`UPCLOUD_${res.status}${errorCode ? `_${errorCode}` : ""}`),
        {
          status: res.status,
          errorCode,
        },
      );
    }
    return res.status === 204 ? null : res.json();
  }
  async list() {
    const all: any[] = [];
    for (let offset = 0; ; offset += 100) {
      const result = await this.call(`/server?limit=100&offset=${offset}`),
        rows = result.servers?.server;
      if (!Array.isArray(rows)) throw Error("UPCLOUD_INVALID_INVENTORY");
      all.push(...rows);
      if (rows.length < 100) break;
      if (offset > 10000) throw Error("UPCLOUD_PAGINATION_LIMIT");
    }
    return all;
  }
  async find(hostname: string) {
    const found = (await this.list()).filter((s) => s.hostname === hostname);
    if (found.length > 1) throw Error("DUPLICATE_PROVIDER_RESOURCES");
    return found[0];
  }
  async create(hostname: string, tenantId: string, userData: string) {
    return (
      await this.call("/server", "POST", {
        server: {
          zone: this.c.UPCLOUD_ZONE,
          plan: this.c.UPCLOUD_PLAN,
          title: `sac-${this.c.BILLING_MODE}-${tenantId}`,
          hostname,
          // Required by UpCloud cloud-init templates. Tenant container egress to
          // the link-local metadata endpoint is blocked by the host firewall.
          metadata: "yes",
          firewall: "off",
          login_user: {
            username: "root",
            create_password: "no",
            ssh_keys: { ssh_key: [this.c.ADMIN_SSH_PUBLIC_KEY] },
          },
          networking: {
            interfaces: {
              interface: [
                {
                  type: "public",
                  ip_addresses: { ip_address: [{ family: "IPv4" }] },
                },
              ],
            },
          },
          storage_devices: {
            storage_device: [
              {
                action: "clone",
                storage: this.c.UPCLOUD_TEMPLATE,
                size: 30,
                tier: "standard",
                title: `sac-${tenantId}-root`,
              },
            ],
          },
          labels: {
            label: [
              { key: "sac-tenant", value: tenantId },
              { key: "sac-mode", value: this.c.BILLING_MODE },
            ],
          },
          user_data: userData,
        },
      })
    ).server;
  }
  async details(id: string) {
    return (await this.call(`/server/${id}`)).server;
  }
  async stop(id: string) {
    const s = await this.details(id);
    if (s.state === "stopped") return;
    if (s.state !== "started") throw Error("PROVIDER_TRANSITIONING");
    await this.call(`/server/${id}/stop`, "POST", {
      stop_server: { stop_type: "soft", timeout: 120 },
    });
  }
  async start(id: string) {
    const s = await this.details(id);
    if (s.state === "started") return;
    if (s.state !== "stopped") throw Error("PROVIDER_TRANSITIONING");
    await this.call(`/server/${id}/start`, "POST", { start_server: {} });
  }
  async destroy(id: string, disks: string[]) {
    try {
      const s = await this.details(id);
      if (s.state !== "stopped") {
        await this.stop(id);
        throw Error("WAITING_FOR_STOP");
      }
      await this.call(`/server/${id}`, "DELETE");
    } catch (e: any) {
      if (e.status !== 404) throw e;
    }
    for (const disk of disks)
      try {
        await this.call(`/storage/${disk}`, "DELETE");
      } catch (e: any) {
        if (e.status !== 404) throw e;
      }
  }
}
