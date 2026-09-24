import type { Config } from "../config.js";
export class DNS {
  constructor(readonly c: Config) {}
  async call(path: string, method = "GET", data?: unknown): Promise<any> {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${this.c.CLOUDFLARE_ZONE_ID}/dns_records${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.c.CLOUDFLARE_TOKEN}`,
          "content-type": "application/json",
        },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!res.ok)
      throw Object.assign(Error(`DNS_${res.status}`), { status: res.status });
    const json: any = await res.json();
    if (!json.success) throw Error("DNS_FAILURE");
    return json.result;
  }
  async ensure(hostname: string, ip: string) {
    const records = await this.call(
      `?type=A&name=${encodeURIComponent(hostname)}`,
    );
    if (records.length > 1) throw Error("DUPLICATE_DNS");
    if (records[0] && records[0].comment !== "sovereign-agent-cloud")
      throw Error("DNS_OWNERSHIP_MISMATCH");
    return (
      await this.call(
        records.length ? `/${records[0].id}` : "",
        records.length ? "PUT" : "POST",
        {
          type: "A",
          name: hostname,
          content: ip,
          ttl: 60,
          proxied: false,
          comment: "sovereign-agent-cloud",
        },
      )
    ).id;
  }
  async remove(id: string) {
    try {
      await this.call(`/${id}`, "DELETE");
    } catch (e: any) {
      if (e.status !== 404) throw e;
    }
  }
}
