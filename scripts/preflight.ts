import { config, models } from "../src/config.js";
import { UpCloud } from "../src/providers/upcloud.js";
import { imagePin } from "../src/provision.js";
const c = config(),
  checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) =>
  checks.push({ name, ok, detail });
check(
  "OpenClaw immutable official image",
  imagePin(c.OPENCLAW_IMAGE) &&
    c.OPENCLAW_IMAGE.startsWith("ghcr.io/openclaw/openclaw:"),
);
check("Tenant immutable image", imagePin(c.TENANT_IMAGE));
for (const key of [
  "UPCloud_TOKEN",
  "CLOUDFLARE_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "SMTP_URL",
  "EMAIL_FROM",
  "BACKUP_S3_BUCKET",
  "BACKUP_AGE_RECIPIENT",
  "ADMIN_CIDR",
  "ADMIN_SSH_PUBLIC_KEY",
]) {
  const k = key === "UPCloud_TOKEN" ? "UPCLOUD_TOKEN" : key;
  check(k, !!(c as any)[k]);
}
if (c.UPCLOUD_TOKEN) {
  try {
    const cloud = new UpCloud(c),
      plans = (await cloud.call("/plan")).plans.plan,
      templates = (await cloud.call("/storage/template")).storages.storage;
    check(
      "UpCloud selected 2 core / 4GB plan",
      plans.some(
        (p: any) =>
          p.name === c.UPCLOUD_PLAN &&
          Number(p.core_number) === 2 &&
          Number(p.memory_amount) === 4096,
      ),
    );
    check(
      "Ubuntu 24.04 template",
      templates.some(
        (t: any) =>
          t.uuid === c.UPCLOUD_TEMPLATE && /ubuntu.*24.04/i.test(t.title),
      ),
    );
  } catch {
    check("UpCloud API read", false);
  }
}
for (const model of models(c)) {
  const key = process.env[model.keyEnv];
  check(`${model.id} secret present`, !!key);
  if (key) {
    try {
      const r = await fetch(model.baseUrl + "/models", {
        headers: { authorization: `Bearer ${key}` },
      });
      const data: any = await r.json();
      check(
        `${model.id} is listed`,
        r.ok && data.data?.some((x: any) => x.id === model.upstreamModel),
      );
    } catch {
      check(`${model.id} model listing`, false);
    }
  }
  check(`${model.id} verified in OpenClaw`, model.verified);
}
console.table(checks);
process.exitCode = checks.every((x) => x.ok) ? 0 : 1;
