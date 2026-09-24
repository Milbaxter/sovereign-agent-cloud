import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { secret } from "../../e2e/config.js";
import { cloud } from "./control.js";
import { GmailInbox } from "../../e2e/inbox.js";

if (process.env.JOURNEY_LIVE_ENABLED !== "true")
  throw Error("LIVE_JOURNEY_NOT_ENABLED");

// No live workflow is launched by CI checks. This entrypoint is exclusively for
// a policy-authorized deployment environment, after review of the committed suite.
for (const name of [
  "JOURNEY_AUTHORIZATION_REFERENCE",
  "JOURNEY_RUNTIME_IMAGE",
  "UPCLOUD_TOKEN",
  "UPCLOUD_TEMPLATE",
  "STRIPE_SECRET_KEY",
  "RESEND_SMTP_PASSWORD",
  "OPENAI_API_KEY",
  "TEST_ACCOUNT_EMAIL",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
])
  secret(name);
if (
  !/^ghcr\.io\/milbaxter\/sovereign-agent-cloud:sha-[a-f0-9]{40}@sha256:[a-f0-9]{64}$/.test(
    secret("JOURNEY_RUNTIME_IMAGE"),
  )
)
  throw Error("PINNED_RUNTIME_REQUIRED");
if (!secret("STRIPE_SECRET_KEY").startsWith("sk_test_"))
  throw Error("TEST_STRIPE_KEY_REQUIRED");
if (process.env.DEBUG || process.env.PWDEBUG)
  throw Error("SECRET_UNSAFE_DEBUGGING_DISABLED");
const budget = Number(process.env.JOURNEY_CLOUD_BUDGET_EUR ?? "9.98");
if (!Number.isFinite(budget) || budget <= 2 || budget > 10)
  throw Error("INVALID_CLOUD_BUDGET");
await new GmailInbox().verifyIdentity();
const initial = Number((await cloud().call("/account")).account.credits);
if (!Number.isFinite(initial)) throw Error("CLOUD_BALANCE_UNVERIFIED");
const runBase = `journey-${Date.now()}-${randomBytes(4).toString("hex")}`;
let active: ReturnType<typeof spawn> | undefined,
  aborted = false,
  failed = false,
  byok = false,
  credits = false,
  cleaning = false;
function stop() {
  aborted = true;
  if (!cleaning && active?.pid) {
    try {
      process.kill(-active.pid, "SIGTERM");
    } catch {}
    const pid = active.pid;
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }, 5000).unref();
  }
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const limit = setTimeout(stop, 40 * 60000);
let checking = false;
const monitor = setInterval(async () => {
  if (checking) return;
  checking = true;
  try {
    const current = Number((await cloud().call("/account")).account.credits);
    const delta = (initial - current) / 100;
    if (!Number.isFinite(delta) || delta < 0 || delta >= budget - 2) stop();
    const servers = await cloud().list();
    if (servers.length > 2) stop();
  } catch {
    stop();
  } finally {
    checking = false;
  }
}, 30000);
async function child(file: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<number>((done) => {
    const p = spawn(process.execPath, ["--import", "tsx", file, ...args], {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    active = p;
    // Never stream tool/API errors or Playwright assertion payloads to public logs.
    p.stdout.resume();
    p.stderr.resume();
    p.on("error", () => done(1));
    p.on("close", (code) => {
      if (active === p) active = undefined;
      done(code ?? 1);
    });
  });
}
try {
  for (const mode of ["byok", "credits"] as const) {
    if (aborted || (mode === "credits" && !byok)) break;
    const env = {
      ...process.env,
      JOURNEY_STATE_DIR: resolve(`data/journey-run/${mode}`),
      JOURNEY_REPORT_DIR: resolve(`journey-report/${mode}`),
      JOURNEY_RUN_ID: `${runBase}-${mode}`,
      JOURNEY_BYOK_PASSED: String(byok),
    };
    console.log(`Starting ${mode} clean journey.`);
    let code = 1;
    try {
      code = await child("scripts/journey/phase.ts", [mode], env);
    } finally {
      // Resource deletion has its own time allowance after the browser test exits.
      cleaning = true;
      const clean = await child("scripts/journey/cleanup.ts", [], env);
      if (clean) failed = true;
      cleaning = false;
    }
    if (code || aborted || failed) {
      failed = true;
      break;
    }
    const results = JSON.parse(
      await readFile(`journey-report/${mode}/results.json`, "utf8"),
    );
    if (
      results.status !== "passed" ||
      results.tests?.length !== 1 ||
      results.tests[0].status !== "passed"
    )
      throw Error("CLEAN_JOURNEY_EVIDENCE_MISSING");
    byok = mode === "byok" || byok;
    credits = mode === "credits";
    console.log(`${mode} clean journey passed and cleaned.`);
  }
} catch {
  failed = true;
} finally {
  clearTimeout(limit);
  clearInterval(monitor);
  await mkdir("journey-report", { recursive: true });
  await writeFile(
    "journey-report/run.json",
    JSON.stringify(
      {
        runId: runBase,
        status:
          failed || aborted || !credits
            ? "failed"
            : "clean_journeys_passed_regressions_pending",
        browserPolicyApprovalReference: secret(
          "JOURNEY_AUTHORIZATION_REFERENCE",
        ),
        byokQualified: byok,
        liveFaultAndLifecycleAcceptance: "pending; see coverage matrix",
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
if (failed || aborted || !credits) process.exitCode = 1;
