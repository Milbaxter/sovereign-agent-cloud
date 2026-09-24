import { manifest, secret } from "./config.js";
import { cloud, sql } from "../scripts/journey/control.js";
import { GmailInbox } from "./inbox.js";
import { assertEncryptedStorage } from "../src/providers/upcloud.js";
export default async function preflight() {
  if (process.env.JOURNEY_LIVE_ENABLED !== "true")
    throw Error("LIVE_JOURNEY_NOT_ENABLED");
  // Audit reference to an actual approval, not an instruction to override policy.
  secret("JOURNEY_AUTHORIZATION_REFERENCE");
  const m = manifest();
  if (Date.now() - Date.parse(m.createdAt) > 45 * 60000)
    throw Error("STALE_JOURNEY_DEPLOYMENT");
  const control = await cloud().details(m.controlId);
  assertEncryptedStorage(control);
  if (control.hostname !== m.controlHostname || control.state !== "started")
    throw Error("CONTROL_OWNERSHIP_MISMATCH");
  if (
    !control.ip_addresses.ip_address.some(
      (ip: any) => ip.address === m.controlIp && ip.access === "public",
    )
  )
    throw Error("CONTROL_IP_MISMATCH");
  if (!secret("STRIPE_SECRET_KEY").startsWith("sk_test_"))
    throw Error("TEST_STRIPE_KEY_REQUIRED");
  await new GmailInbox().verifyIdentity();
  const env = await sql(m, "SELECT name FROM migrations ORDER BY name");
  for (const name of [
    "001_initial.sql",
    "002_operations.sql",
    "003_cost_guards.sql",
    "004_bootstrap_readiness.sql",
  ])
    if (!env.some((r) => r.name === name)) throw Error("MIGRATION_MISSING");
  const response = await fetch(`${m.origin}/api/catalog`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("CATALOG_UNAVAILABLE");
  const catalog = (await response.json()) as any;
  if (
    catalog.billingMode !== "test" ||
    !catalog.checkoutEnabled ||
    catalog.creditsEnabled !== (m.mode === "credits")
  )
    throw Error("TEST_CATALOG_MISMATCH");
}
