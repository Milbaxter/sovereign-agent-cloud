import { readFileSync } from "node:fs";
import { z } from "zod";
const bool = z
  .enum(["true", "false"])
  .default("false")
  .transform((x) => x === "true");
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string(),
  PUBLIC_ORIGIN: z.string().url(),
  SEARCH_INDEXING_ENABLED: bool,
  TENANT_DOMAIN: z.string().regex(/^[a-z0-9.-]+$/),
  BILLING_MODE: z.enum(["test", "live"]).default("test"),
  CHECKOUT_ENABLED: bool,
  CREDITS_ENABLED: bool,
  ENCRYPTION_KEY: z
    .string()
    .refine((x) => Buffer.from(x, "base64").length === 32),
  HANDOFF_PRIVATE_KEY_FILE: z.string(),
  HANDOFF_PUBLIC_KEY_FILE: z.string(),
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  STRIPE_HOSTING_PRICE_ID: z.string().default(""),
  STRIPE_CREDIT_PRICE_ID: z.string().default(""),
  STRIPE_AUTOMATIC_TAX: bool,
  SMTP_URL: z.string().default(""),
  EMAIL_FROM: z.string().default(""),
  UPCLOUD_TOKEN: z.string().default(""),
  UPCLOUD_ZONE: z.literal("fi-hel1").default("fi-hel1"),
  UPCLOUD_PLAN: z.string().default(""),
  UPCLOUD_TEMPLATE: z.string().default(""),
  CLOUDFLARE_TOKEN: z.string().default(""),
  CLOUDFLARE_ZONE_ID: z.string().default(""),
  OPENCLAW_IMAGE: z.string().default(""),
  TENANT_IMAGE: z.string().default(""),
  ADMIN_SSH_PUBLIC_KEY: z.string().default(""),
  ADMIN_CIDR: z.string().default(""),
  BACKUP_S3_ENDPOINT: z.string().default(""),
  BACKUP_S3_BUCKET: z.string().default(""),
  BACKUP_ACCESS_KEY: z.string().default(""),
  BACKUP_SECRET_KEY: z.string().default(""),
  BACKUP_AGE_RECIPIENT: z.string().default(""),
  MODEL_CONFIG_FILE: z.string().default("models.json"),
  RELEASE_EVIDENCE_FILE: z.string().default("release-evidence.json"),
  MAX_TENANTS: z.coerce.number().int().positive().default(50),
});
export type Config = z.infer<typeof schema> & {
  privateKey: string;
  publicKey: string;
};
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const c = schema.parse(env);
  if (c.NODE_ENV === "production" && !c.PUBLIC_ORIGIN.startsWith("https://"))
    throw Error("HTTPS_REQUIRED");
  if (
    c.STRIPE_SECRET_KEY &&
    !c.STRIPE_SECRET_KEY.startsWith(
      c.BILLING_MODE === "live" ? "sk_live_" : "sk_test_",
    )
  )
    throw Error("STRIPE_MODE_MISMATCH");
  return {
    ...c,
    privateKey: readFileSync(c.HANDOFF_PRIVATE_KEY_FILE, "utf8"),
    publicKey: readFileSync(c.HANDOFF_PUBLIC_KEY_FILE, "utf8"),
  };
}
export const modelSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.string(),
  country: z.string(),
  baseUrl: z
    .string()
    .url()
    .refine((s) => s.startsWith("https://")),
  keyEnv: z.string(),
  upstreamModel: z.string(),
  rateVersion: z.string(),
  inputMicroEurPerMillion: z.coerce.bigint().nonnegative(),
  cachedMicroEurPerMillion: z.coerce.bigint().nonnegative(),
  outputMicroEurPerMillion: z.coerce.bigint().nonnegative(),
  maxContext: z.number().int().positive(),
  maxOutput: z.number().int().positive(),
  verified: z.boolean(),
  verifiedAt: z.string().datetime().optional(),
});
export type Model = z.infer<typeof modelSchema>;
export function models(c: Config): Model[] {
  return z
    .array(modelSchema)
    .parse(JSON.parse(readFileSync(c.MODEL_CONFIG_FILE, "utf8")));
}
export function launchGate(c: Config, credits = false) {
  if (!c.CHECKOUT_ENABLED || (credits && !c.CREDITS_ENABLED))
    throw Object.assign(Error("CHECKOUT_NOT_ENABLED"), { statusCode: 503 });
  if (c.BILLING_MODE === "live") {
    const evidence = JSON.parse(readFileSync(c.RELEASE_EVIDENCE_FILE, "utf8"));
    for (const name of [
      "paidProvisioning",
      "byokOnboarding",
      "creditOnboarding",
      "channels",
      "isolation",
      "ledger",
      "migration",
      "backupLifecycle",
      "pilot",
    ])
      if (
        evidence[name]?.passed !== true ||
        typeof evidence[name]?.evidence !== "string" ||
        !evidence[name].evidence.trim()
      )
        throw Object.assign(Error("LAUNCH_EVIDENCE_MISSING"), {
          statusCode: 503,
        });
  }
}

// The catalog and purchase endpoints must report the same effective gate.
export function checkoutAvailable(c: Config, credits = false): boolean {
  try {
    launchGate(c, credits);
    return true;
  } catch {
    return false;
  }
}
