import type { Config } from "../config.js";
export class UpCloud {
  constructor(readonly c: Config) {}
  async call(path: string, method = "GET", body?: unknown): Promise<any> {
    const res = await fetch(`https://api.upcloud.com/1.3${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.c.UPCLOUD_TOKEN}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok)
      throw Object.assign(Error(`UPCLOUD_${res.status}`), {
        status: res.status,
      });
    return res.status === 204 ? null : res.json();
  }
  async list() {
    const all: any[] = [];
    for (let offset = 0; ; offset += 100) {
      const result = await this.call(`/server?limit=100&offset=${offset}`),
        rows = result.servers?.server ?? [];
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
          metadata: "no",
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
