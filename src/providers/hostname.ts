import { isIP } from "node:net";
import type { Config } from "../config.js";

// Cloud identity must not change when a test's public hostname acquires its IP.
export const providerHostname = (tenant: any): string =>
  tenant.provider_hostname ?? tenant.hostname;

export function publicHostname(c: Config, tenant: any, ip: string): string {
  if (c.DNS_MODE !== "test_sslip") return tenant.hostname;
  if (c.BILLING_MODE !== "test") throw Error("TEST_DNS_REQUIRES_TEST_BILLING");
  if (isIP(ip) !== 4) throw Error("PUBLIC_IPV4_REQUIRED");
  return `a-${tenant.id}.${ip.replaceAll(".", "-")}.sslip.io`;
}
