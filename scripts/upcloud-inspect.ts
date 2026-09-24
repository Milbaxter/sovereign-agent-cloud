import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { UpCloud } from "../src/providers/upcloud.js";

// This command needs only the cloud token, not database, Stripe or signing keys.
// Parse the credentials as data; never source/execute the file as shell code.
const path = join(homedir(), ".config/upcloud-agent/credentials.env");
const credentials = await readFile(path, "utf8")
  .then(parseEnv)
  .catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return {} as Record<string, string>;
  });
const cloud = new UpCloud({
  UPCLOUD_TOKEN: process.env.UPCLOUD_TOKEN || credentials.UPCLOUD_TOKEN || "",
  UPCLOUD_ZONE: "fi-hel1",
  UPCLOUD_PLAN: "",
  UPCLOUD_TEMPLATE: "",
  ADMIN_SSH_PUBLIC_KEY: "",
  BILLING_MODE: "test",
});

try {
  const [account, plans, templates, zones, prices] = await Promise.all([
    cloud.call("/account"),
    cloud.call("/plan"),
    cloud.call("/storage/template"),
    cloud.call("/zone"),
    cloud.call("/price"),
  ]);
  const candidates = plans.plans.plan.filter(
    (p: any) => Number(p.core_number) === 2 && Number(p.memory_amount) === 4096,
  );
  const ubuntu = templates.storages.storage.filter(
    (t: any) =>
      t.access === "public" &&
      t.template_type === "cloud-init" &&
      /ubuntu.*24\.04/i.test(t.title),
  );
  const zone = zones.zones.zone.find((z: any) => z.id === "fi-hel1");
  const pricing = prices.prices.zone.find((z: any) => z.name === "fi-hel1");
  console.log(
    JSON.stringify(
      {
        readOnly: true,
        authenticated: true,
        credits: account.account.credits,
        creditExpiry:
          account.account.credits_breakdown?.account_free_credits?.breakdown ??
          "Not exposed for this account; verify in the control panel.",
        zone,
        plans: candidates.map((p: any) => ({
          ...p,
          price: pricing?.[`server_plan_${p.name}`] ?? null,
        })),
        templates: ubuntu.map((t: any) => ({
          uuid: t.uuid,
          title: t.title,
          template_type: t.template_type,
          size: t.size,
        })),
        pricingCurrency: prices.prices.currency,
        additionalResourcePrices: Object.fromEntries(
          [
            "ipv4_address",
            "storage_standard",
            "storage_maxiops",
            "storage_backup",
          ].map((key) => [key, pricing?.[key] ?? null]),
        ),
      },
      null,
      2,
    ),
  );
  if (!zone || !candidates.length || !ubuntu.length) process.exitCode = 1;
} catch (error: any) {
  console.error(
    /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "UPCLOUD_INSPECTION_FAILED",
  );
  process.exitCode = 1;
}
