import { resolve } from "node:path";
import { deploy, command, root } from "./control.js";
import { secret } from "../../e2e/config.js";
import { GmailInbox } from "../../e2e/inbox.js";
const mode = process.argv[2];
if (mode !== "byok" && mode !== "credits") throw Error("JOURNEY_MODE_REQUIRED");
secret("JOURNEY_AUTHORIZATION_REFERENCE");
if (mode === "credits" && process.env.JOURNEY_BYOK_PASSED !== "true")
  throw Error("BYOK_QUALIFICATION_REQUIRED");
try {
  await new GmailInbox().verifyIdentity();
  const m = await deploy(mode, secret("JOURNEY_RUN_ID"));
  process.env.JOURNEY_MANIFEST = resolve(root, "manifest.json");
  const deadline = Date.now() + 120000;
  while (true) {
    try {
      const r = await fetch(`${m.origin}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) throw Error("HTTPS_NOT_READY");
    await new Promise((r) => setTimeout(r, 3000));
  }
  await command(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test"],
    undefined,
    32 * 60000,
  );
} catch {
  console.error(
    "Customer journey phase failed; consult the sanitized report. No acceptance pass is implied.",
  );
  process.exitCode = 1;
}
