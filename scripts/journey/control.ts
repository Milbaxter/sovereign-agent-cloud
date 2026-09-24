import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import Stripe from "stripe";
import {
  UpCloud,
  assertEncryptedStorage,
} from "../../src/providers/upcloud.js";
import { cleanupStages } from "./cleanup-order.js";
import { EVENT_TYPES } from "../../src/billing.js";
import { manifestSchema, secret, type Manifest } from "../../e2e/config.js";
import { writePrivate } from "../../e2e/evidence.js";

export const root = resolve(
  process.env.JOURNEY_STATE_DIR ?? "data/journey-run",
);
const statePath = resolve(root, "state.json");
type State = {
  runId: string;
  createdAt: string;
  initial: {
    servers: string[];
    disks: string[];
    ips: string[];
    credits: number;
  };
  controlId?: string;
  controlIp?: string;
  disks: string[];
  products: string[];
  prices: string[];
  webhookId?: string;
  webhookSecret?: string;
  manifest?: Manifest;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const quote = (value: string) =>
  "'" + value.replaceAll("'", "'\\''") + "'";
export async function command(
  binary: string,
  args: string[],
  input?: string,
  timeout = 120000,
): Promise<string> {
  return new Promise((done, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Error("COMMAND_TIMEOUT"));
    }, timeout);
    child.stdout.on("data", (part) => {
      out += part;
      if (out.length > 4_000_000) child.kill("SIGTERM");
    });
    // Child stderr may contain secrets. Only export a stable failure code.
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      reject(Error("COMMAND_START_FAILED"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? done(out) : reject(Error("COMMAND_FAILED"));
    });
    child.stdin.end(input);
  });
}
export function cloud() {
  return new UpCloud({
    UPCLOUD_TOKEN: secret("UPCLOUD_TOKEN"),
    UPCLOUD_ZONE: "fi-hel1",
    UPCLOUD_PLAN: "STARTER-2xCPU-4GB",
    UPCLOUD_TEMPLATE: secret("UPCLOUD_TEMPLATE"),
    ADMIN_SSH_PUBLIC_KEY: "",
    BILLING_MODE: "test",
  });
}
function stripe() {
  const key = secret("STRIPE_SECRET_KEY");
  if (!key.startsWith("sk_test_")) throw Error("TEST_STRIPE_KEY_REQUIRED");
  return new Stripe(key, { maxNetworkRetries: 2 });
}
export async function loadState(): Promise<State> {
  return JSON.parse(await readFile(statePath, "utf8"));
}
async function save(s: State) {
  await writePrivate(statePath, s);
}
export async function ssh(
  m: Pick<Manifest, "controlIp">,
  script: string,
  input?: string,
  timeout = 120000,
) {
  return command(
    "ssh",
    [
      "-i",
      resolve(root, "ssh"),
      "-o",
      `UserKnownHostsFile=${resolve(root, "known_hosts")}`,
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      `root@${m.controlIp}`,
      script,
    ],
    input,
    timeout,
  );
}
async function upload(ip: string, local: string, remote: string) {
  await command("scp", [
    "-q",
    "-i",
    resolve(root, "ssh"),
    "-o",
    `UserKnownHostsFile=${resolve(root, "known_hosts")}`,
    local,
    `root@${ip}:${remote}`,
  ]);
}
export async function sql(
  m: Manifest,
  query: string,
  values: unknown[] = [],
): Promise<any[]> {
  const input = Buffer.from(JSON.stringify({ query, values })).toString(
    "base64",
  );
  const program = `const {Client}=require('pg');const a=JSON.parse(Buffer.from(process.argv[1],'base64'));const c=new Client({connectionString:process.env.DATABASE_URL});(async()=>{await c.connect();await c.query('BEGIN READ ONLY');const r=await c.query(a.query,a.values);await c.query('COMMIT');process.stdout.write(JSON.stringify(r.rows));await c.end();})().catch(()=>process.exit(1));`;
  return JSON.parse(
    await ssh(
      m,
      `cd /opt/journey && docker compose exec -T api node -e ${quote(program)} ${quote(input)}`,
    ),
  );
}
async function inventory() {
  const c = cloud();
  const [servers, disks, ips, account] = await Promise.all([
    c.list(),
    c.call("/storage/private"),
    c.call("/ip_address"),
    c.call("/account"),
  ]);
  return {
    servers: servers.map((s) => s.uuid as string),
    disks: (disks.storages.storage as any[]).map((s) => s.uuid as string),
    ips: (ips.ip_addresses.ip_address as any[]).map((i) => i.address as string),
    credits: Number(account.account.credits),
  };
}
export async function budgetCheck() {
  const state = await loadState();
  const account = (await cloud().call("/account")).account;
  // This account's EUR billing showed 100 credit units per euro. Fail closed on a changed currency.
  const prices = (await cloud().call("/price")).prices;
  if ((account.currency ?? prices.currency) !== "EUR")
    throw Error("UNSUPPORTED_CLOUD_BUDGET_CURRENCY");
  const spent = (state.initial.credits - Number(account.credits)) / 100;
  if (!Number.isFinite(spent) || spent < 0 || spent >= 8)
    throw Error("CLOUD_BUDGET_STOP");
  if (Date.now() - Date.parse(state.createdAt) > 45 * 60000)
    throw Error("JOURNEY_RUNTIME_STOP");
  const owned = (await cloud().list()).filter(
    (s) =>
      s.hostname === state.runId ||
      s.hostname.endsWith(`.${state.runId}.invalid`),
  );
  if (owned.length > 2) throw Error("JOURNEY_RESOURCE_LIMIT");
  return spent;
}
export async function deploy(
  mode: "byok" | "credits",
  runId: string,
): Promise<Manifest> {
  if (!/^journey-[a-z0-9-]{8,60}$/.test(runId)) throw Error("INVALID_RUN_ID");
  await mkdir(root, { recursive: true, mode: 0o700 });
  // An interrupted run must be cleaned, never overwritten with a second create.
  try {
    await readFile(statePath);
    throw Error("EXISTING_RUN_REQUIRES_CLEANUP");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const initial = await inventory();
  if (initial.servers.length || initial.disks.length || initial.ips.length)
    throw Error("EMPTY_TEST_ACCOUNT_REQUIRED");
  const c = cloud(),
    s = stripe();
  const [plans, prices, account] = await Promise.all([
    c.call("/plan"),
    c.call("/price"),
    c.call("/account"),
  ]);
  for (const plan of ["STARTER-2xCPU-4GB", "CLOUDNATIVE-1xCPU-4GB"])
    if (!plans.plans.plan.some((p: any) => p.name === plan))
      throw Error("REQUIRED_PLAN_UNAVAILABLE");
  if (
    (account.account.currency ?? prices.prices.currency) !== "EUR" ||
    initial.credits < 1000
  )
    throw Error("CLOUD_BUDGET_UNVERIFIED");
  const free =
    account.account.credits_breakdown?.account_free_credits?.breakdown ?? [];
  const durableCredits =
    Number(
      account.account.credits_breakdown?.account_credits?.paid_credits ?? 0,
    ) +
    free
      .filter(
        (row: any) =>
          Date.parse(row.free_credits_expire) > Date.now() + 2 * 3600000,
      )
      .reduce((sum: number, row: any) => sum + Number(row.free_credits), 0);
  if (durableCredits < 1000) throw Error("CLOUD_CREDIT_EXPIRY_UNVERIFIED");
  const zone = prices.prices.zone.find((z: any) => z.name === "fi-hel1");
  const selectedPrices = [
    zone?.["server_plan_STARTER-2xCPU-4GB"]?.price,
    zone?.ipv4_address?.price,
    zone?.storage_standard?.price,
  ];
  if (selectedPrices.some((p) => !Number.isFinite(Number(p)) || Number(p) < 0))
    throw Error("CLOUD_PRICES_UNVERIFIED");
  if (
    (Number(selectedPrices[0]) +
      Number(selectedPrices[1]) +
      30 * Number(selectedPrices[2])) /
      100 >
    0.1
  )
    throw Error("CLOUD_PRICES_EXCEED_TEST_EXPECTATION");
  const templates = (await c.call("/storage/template")).storages.storage;
  if (
    !templates.some(
      (t: any) =>
        t.uuid === c.c.UPCLOUD_TEMPLATE &&
        t.access === "public" &&
        t.template_type === "cloud-init" &&
        /ubuntu.*24\.04/i.test(t.title),
    )
  )
    throw Error("UBUNTU_TEMPLATE_UNVERIFIED");
  await mkdir(process.env.JOURNEY_REPORT_DIR ?? "journey-report", {
    recursive: true,
  });
  await writeFile(
    resolve(
      process.env.JOURNEY_REPORT_DIR ?? "journey-report",
      "preflight.json",
    ),
    JSON.stringify(
      {
        currency: "EUR",
        rawCreditUnitsPerEuro: 100,
        selectedPrices,
        creditsValidForRun: true,
        initialInventoryEmpty: true,
      },
      null,
      2,
    ),
  );
  const state: State = {
    runId,
    createdAt: new Date().toISOString(),
    initial,
    disks: [],
    products: [],
    prices: [],
  };
  await save(state);
  await command("ssh-keygen", [
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    runId,
    "-f",
    resolve(root, "ssh"),
  ]);
  c.c.ADMIN_SSH_PUBLIC_KEY = (
    await readFile(resolve(root, "ssh.pub"), "utf8")
  ).trim();
  // Restrict SSH before starting application services. Keep HTTP(S) public for the real journey.
  const operatorIp = (
    await (
      await fetch("https://api.ipify.org", {
        signal: AbortSignal.timeout(10000),
      })
    ).text()
  ).trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(operatorIp))
    throw Error("OPERATOR_IPV4_REQUIRED");
  const created = await c.create(
    runId,
    runId,
    `#!/bin/bash\nset -euo pipefail\numask 077\napt-get update -qq\nDEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 age ufw\nufw default deny incoming\nufw allow from ${operatorIp} to any port 22 proto tcp\nufw allow 80/tcp\nufw allow 443/tcp\nufw --force enable\nsystemctl enable --now docker\ninstall -d -m700 /opt/journey/secrets /opt/journey/deploy\nage-keygen -o /opt/journey/secrets/backup.age\ntouch /opt/journey/control-ready\n`,
  );
  state.controlId = created.uuid;
  await save(state);
  let details: any;
  const deadline = Date.now() + 10 * 60000;
  while (Date.now() < deadline) {
    details = await c.details(created.uuid);
    assertEncryptedStorage(details);
    state.disks = details.storage_devices.storage_device.map(
      (d: any) => d.storage,
    );
    state.controlIp = details.ip_addresses.ip_address.find(
      (a: any) => a.family === "IPv4" && a.access === "public",
    )?.address;
    await save(state);
    if (details.state === "started" && state.controlIp) {
      try {
        await ssh(
          { controlIp: state.controlIp },
          "test -f /opt/journey/control-ready",
        );
        break;
      } catch {}
    }
    await pause(10000);
  }
  if (!state.controlIp) throw Error("CONTROL_ADDRESS_MISSING");
  const ip = state.controlIp;
  await ssh({ controlIp: ip }, "test -f /opt/journey/control-ready");
  const origin = `https://control.${ip.replaceAll(".", "-")}.sslip.io`;
  for (const [kind, amount] of [
    ["hosting", 2500],
    ["credits", 1000],
  ] as const) {
    const product = await s.products.create(
      { name: `Journey ${kind}`, metadata: { journey_run: runId } },
      { idempotencyKey: `${runId}-${kind}-product` },
    );
    state.products.push(product.id);
    await save(state);
    const price = await s.prices.create(
      {
        product: product.id,
        currency: "eur",
        unit_amount: amount,
        tax_behavior: "exclusive",
        ...(kind === "hosting"
          ? { recurring: { interval: "month" as const } }
          : {}),
        metadata: { journey_run: runId },
      },
      { idempotencyKey: `${runId}-${kind}-price` },
    );
    state.prices.push(price.id);
    await save(state);
  }
  const webhook = await s.webhookEndpoints.create(
    {
      url: `${origin}/webhooks/stripe`,
      enabled_events: [...EVENT_TYPES] as any,
      metadata: { journey_run: runId },
    },
    { idempotencyKey: `${runId}-webhook` },
  );
  state.webhookId = webhook.id;
  state.webhookSecret = webhook.secret;
  await save(state);
  const pair = generateKeyPairSync("ed25519"),
    password = randomBytes(32).toString("hex");
  for (const [name, key, type] of [
    ["private", pair.privateKey, "pkcs8"],
    ["public", pair.publicKey, "spki"],
  ] as const) {
    await writeFile(
      resolve(root, `handoff-${name}.pem`),
      key.export({ type, format: "pem" }),
      { mode: 0o600 },
    );
  }
  const smtp = new URL("smtps://smtp.resend.com:465");
  smtp.username = "resend";
  smtp.password = secret("RESEND_SMTP_PASSWORD");
  const recipient = (
    await ssh(
      { controlIp: ip },
      "age-keygen -y /opt/journey/secrets/backup.age",
    )
  ).trim();
  const m = manifestSchema.parse({
    runId,
    mode,
    origin,
    controlId: state.controlId,
    controlIp: ip,
    controlHostname: runId,
    tenantDomain: `${runId}.invalid`,
    hostingPrice: state.prices[0],
    creditPrice: state.prices[1],
    webhookId: webhook.id,
    runtimeImage: secret("JOURNEY_RUNTIME_IMAGE"),
    openclawImage:
      "ghcr.io/openclaw/openclaw:2026.9.6-browser@sha256:62832668e3e5e139f745f7d3df892c9251eb53318b7d14a76c410dde1f25d730",
    model: "gpt-4.1-mini-2025-04-14",
    modelId: "openai-journey",
    markerUrl: `${origin}/journey-marker`,
    marker: `JOURNEY_${randomBytes(16).toString("hex").toUpperCase()}`,
    createdAt: state.createdAt,
  });
  const env = {
    NODE_ENV: "production",
    PORT: "3000",
    POSTGRES_PASSWORD: password,
    DATABASE_URL: `postgres://sovereign:${password}@postgres:5432/sovereign`,
    PUBLIC_ORIGIN: origin,
    PORTAL_DOMAIN: new URL(origin).hostname,
    TENANT_DOMAIN: m.tenantDomain,
    DNS_MODE: "test_sslip",
    TEST_ACCOUNT_EMAIL: secret("TEST_ACCOUNT_EMAIL"),
    SEARCH_INDEXING_ENABLED: "false",
    BILLING_MODE: "test",
    CHECKOUT_ENABLED: "true",
    CREDITS_ENABLED: String(mode === "credits"),
    MAX_TENANTS: "1",
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    HANDOFF_PRIVATE_KEY_FILE: "secrets/handoff-private.pem",
    HANDOFF_PUBLIC_KEY_FILE: "secrets/handoff-public.pem",
    SMTP_URL: smtp.toString(),
    EMAIL_FROM: "Your Agent Test <onboarding@resend.dev>",
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
    STRIPE_WEBHOOK_SECRET: webhook.secret!,
    STRIPE_HOSTING_PRICE_ID: m.hostingPrice,
    STRIPE_CREDIT_PRICE_ID: m.creditPrice,
    STRIPE_AUTOMATIC_TAX: "false",
    UPCLOUD_TOKEN: secret("UPCLOUD_TOKEN"),
    UPCLOUD_ZONE: "fi-hel1",
    UPCLOUD_PLAN: c.c.UPCLOUD_PLAN,
    UPCLOUD_TEMPLATE: c.c.UPCLOUD_TEMPLATE,
    TENANT_IMAGE: m.runtimeImage,
    OPENCLAW_IMAGE: m.openclawImage,
    ADMIN_SSH_PUBLIC_KEY: c.c.ADMIN_SSH_PUBLIC_KEY,
    ADMIN_CIDR: `${operatorIp}/32`,
    BACKUP_AGE_RECIPIENT: recipient,
    MODEL_CONFIG_FILE: "models.json",
    RELEASE_EVIDENCE_FILE: "release-evidence.json",
    OPENAI_API_KEY: secret("OPENAI_API_KEY"),
  };
  await writeFile(
    resolve(root, ".env"),
    Object.entries(env)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  await writePrivate(resolve(root, "models.json"), [
    {
      id: m.modelId,
      label: "GPT-4.1 mini journey test",
      provider: "OpenAI",
      country: "Test only; no EU residency claim",
      baseUrl: "https://api.openai.com/v1",
      keyEnv: "OPENAI_API_KEY",
      upstreamModel: m.model,
      rateVersion: runId,
      inputMicroEurPerMillion: "400000",
      cachedMicroEurPerMillion: "100000",
      outputMicroEurPerMillion: "1600000",
      maxContext: 32768,
      maxOutput: 2048,
      verified: mode === "credits",
    },
  ]);
  const compose = parse(await readFile("compose.yml", "utf8"));
  for (const name of ["migrate", "api", "worker"]) {
    delete compose.services[name].build;
    compose.services[name].image = m.runtimeImage;
  }
  await writeFile(resolve(root, "compose.yml"), stringify(compose));
  // Marker isn't included in a model prompt; observing it requires the actual browser tool.
  await writeFile(
    resolve(root, "Caddyfile"),
    `${new URL(origin).hostname} {\n header X-Robots-Tag "noindex,nofollow"\n header Strict-Transport-Security "max-age=31536000"\n handle /journey-marker {\n  header Content-Type "text/html; charset=utf-8"\n  respond "<html><body><h1>Customer journey marker</h1><p>${m.marker}</p></body></html>" 200\n }\n handle {\n  reverse_proxy api:3000\n }\n}\n`,
  );
  for (const name of [".env", "compose.yml", "models.json"])
    await upload(ip, resolve(root, name), `/opt/journey/${name}`);
  for (const name of ["private", "public"])
    await upload(
      ip,
      resolve(root, `handoff-${name}.pem`),
      `/opt/journey/secrets/handoff-${name}.pem`,
    );
  await upload(
    ip,
    "release-evidence.json",
    "/opt/journey/release-evidence.json",
  );
  await upload(ip, resolve(root, "Caddyfile"), "/opt/journey/deploy/Caddyfile");
  await ssh(m, "cd /opt/journey && docker compose up -d", undefined, 8 * 60000);
  state.manifest = m;
  await save(state);
  await writePrivate(resolve(root, "manifest.json"), m);
  return m;
}
export async function cleanup() {
  let state: State;
  try {
    state = await loadState();
  } catch (e: any) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  const c = cloud(),
    s = stripe(),
    failures: string[] = [];
  if (state.controlIp)
    await ssh(
      { controlIp: state.controlIp },
      "cd /opt/journey && docker compose stop worker",
      undefined,
      60000,
    ).catch(() => {});
  failures.push(
    ...(await cleanupStages([
      {
        name: "BILLING_CLEANUP_FAILED",
        run: async () => {
          if (state.webhookId)
            await s.webhookEndpoints
              .update(state.webhookId, { disabled: true })
              .catch(() => failures.push("WEBHOOK_DISABLE_FAILED"));
          for await (const subscription of s.subscriptions.list({
            status: "all",
            limit: 100,
          })) {
            if (
              subscription.items.data.some((item) =>
                state.prices.includes(item.price.id),
              ) &&
              subscription.status !== "canceled"
            )
              await s.subscriptions
                .cancel(subscription.id)
                .catch(() => failures.push("SUBSCRIPTION_CANCEL_FAILED"));
          }
          // Reconcile objects whose create response may have been lost before the journal write.
          for await (const endpoint of s.webhookEndpoints.list({ limit: 100 }))
            if (endpoint.metadata?.journey_run === state.runId)
              await s.webhookEndpoints
                .update(endpoint.id, { disabled: true })
                .catch(() => failures.push("WEBHOOK_DISABLE_FAILED"));
          for await (const price of s.prices.list({ limit: 100 }))
            if (price.metadata.journey_run === state.runId)
              await s.prices
                .update(price.id, { active: false })
                .catch(() => failures.push("PRICE_ARCHIVE_FAILED"));
          for await (const product of s.products.list({ limit: 100 }))
            if (product.metadata.journey_run === state.runId)
              await s.products
                .update(product.id, { active: false })
                .catch(() => failures.push("PRODUCT_ARCHIVE_FAILED"));
        },
      },
    ])),
  );
  const deadline = Date.now() + 6 * 60000;
  while (Date.now() < deadline) {
    const owned = (await c.list()).filter(
      (v) =>
        v.hostname === state.runId ||
        v.hostname.endsWith(`.${state.runId}.invalid`),
    );
    for (const server of owned) {
      const detail = await c.details(server.uuid);
      const labels = detail.labels?.label ?? [];
      if (!labels.some((l: any) => l.key === "sac-mode" && l.value === "test"))
        throw Error("CLEANUP_OWNERSHIP_MISMATCH");
      const ids = detail.storage_devices.storage_device.map(
        (d: any) => d.storage,
      );
      state.disks = [...new Set([...state.disks, ...ids])];
      await save(state);
      try {
        await c.destroy(server.uuid, ids);
      } catch (e: any) {
        if (!["WAITING_FOR_STOP", "PROVIDER_TRANSITIONING"].includes(e.message))
          failures.push("SERVER_DELETE_FAILED");
      }
    }
    if (!owned.length) break;
    await pause(10000);
  }
  for (const id of state.disks)
    try {
      await c.call(`/storage/${id}`, "DELETE");
    } catch (e: any) {
      if (e.status !== 404) failures.push("DISK_DELETE_FAILED");
    }
  const final = await inventory();
  const delta = {
    servers: final.servers.filter((x) => !state.initial.servers.includes(x)),
    disks: final.disks.filter((x) => !state.initial.disks.includes(x)),
    ips: final.ips.filter((x) => !state.initial.ips.includes(x)),
  };
  const report = process.env.JOURNEY_REPORT_DIR ?? "journey-report";
  await mkdir(report, { recursive: true });
  await writeFile(
    `${report}/cleanup.json`,
    JSON.stringify(
      {
        runId: state.runId,
        at: new Date().toISOString(),
        remaining: delta,
        failures,
        cloudConsumptionEur: (state.initial.credits - final.credits) / 100,
      },
      null,
      2,
    ),
  );
  if (failures.length || Object.values(delta).some((a) => a.length))
    throw Error("CLEANUP_INCOMPLETE");
}
