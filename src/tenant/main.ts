import Fastify from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import {
  readFile,
  writeFile,
  mkdir,
  appendFile,
  unlink,
  stat,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { consumeTicket } from "./tickets.js";
import { gatewayProxy } from "./gateway-proxy.js";
import { tenantSession } from "./session.js";
import { tenantSecurity, TENANT_COOKIE } from "./security.js";
import { z } from "zod";
import { token, hash } from "../crypto.js";
const exec = promisify(execFile),
  b = JSON.parse(
    await readFile(process.env.TENANT_CONFIG ?? "/opt/sac/tenant.json", "utf8"),
  );
const origin = `https://${b.hostname}`;
const db = new DatabaseSync("/var/lib/sac/access.sqlite");
db.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY,expiry INTEGER); CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,created INTEGER,expiry INTEGER,action TEXT,recipient TEXT); CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,session_hash TEXT,path TEXT,expiry INTEGER); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);",
);
const app = Fastify({
  logger: false,
  bodyLimit: 10000,
  // Listener is loopback-only and Caddy replaces the forwarded client address.
  trustProxy: (_address: string, hop: number) => hop === 0,
});
await app.register(cookie);
await app.register(rateLimit, { max: 60, timeWindow: "1 minute" });
app.setErrorHandler((e: any, _req, reply) =>
  reply
    .code(e.statusCode ?? 500)
    .send({ error: e.statusCode ? e.message : "OPERATION_FAILED" }),
);
function auth(req: any) {
  return tenantSession(db, req.cookies[TENANT_COOKIE]) as any;
}
tenantSecurity(app, origin, b.managementKey);
const claw = async (args: string[]) =>
  exec("docker", ["exec", "openclaw", "node", "dist/index.js", ...args], {
    timeout: 60000,
    maxBuffer: 2_000_000,
  });
gatewayProxy(app, db, origin);
// Each asset and socket handshake invokes forward_auth; do not throttle a page's auth subrequests.
app.get("/authorize", { config: { rateLimit: false } }, async (req, reply) => {
  const s = auth(req);
  if (
    s.action !== "access" ||
    db.prepare("SELECT value FROM settings WHERE key='suspended'").get()
      ?.value === "true"
  )
    return reply.code(403).send();
  return reply.code(204).send();
});
app.post("/handoff", async (req, reply) => {
  const { ticket } = z.object({ ticket: z.string().max(4096) }).parse(req.body);
  const { sid, action } = await consumeTicket(
    db,
    b.publicKey,
    ticket,
    b.tenantId,
    origin,
  );
  reply.setCookie(TENANT_COOKIE, sid, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 3600,
  });
  return { next: action === "export" ? "/export" : "/setup" };
});
app.get("/internal/status", async () => {
  const installed = await exec("docker", [
    "inspect",
    "-f",
    "{{.State.Running}}",
    "openclaw",
  ])
    .then((r) => r.stdout.trim() === "true")
    .catch(() => false);
  const configured = await claw([
    "config",
    "get",
    "agents.defaults.model.primary",
  ])
    .then((r) => !!r.stdout.trim())
    .catch(() => false);
  const free = await exec("df", ["-Pk", "/var/lib/sac"])
    .then((r) =>
      Number(r.stdout.trim().split("\n").at(-1)!.trim().split(/\s+/)[3]),
    )
    .catch(() => 0);
  const complete = await stat("/var/lib/sac/bootstrap-complete")
    .then(() => true)
    .catch(() => false);
  return { installed: installed && complete, configured, freeDiskKiB: free };
});
app.post("/internal/prepaid", async () => {
  if (b.mode !== "credits" || !b.model || !b.inferenceKey)
    throw Error("PREPAID_NOT_CONFIGURED");
  const primary = await claw(["config", "get", "agents.defaults.model.primary"])
    .then((r) => r.stdout.trim())
    .catch(() => "");
  if (primary) return { ok: true };
  await claw([
    "config",
    "set",
    "models.providers.sovereign",
    JSON.stringify({
      baseUrl: `${b.controlOrigin}/v1`,
      api: "openai-completions",
      apiKey: "${SAC_INFERENCE_KEY}",
      models: [
        {
          id: b.model.id,
          name: b.model.label,
          contextWindow: b.model.maxContext,
          maxTokens: b.model.maxOutput,
        },
      ],
    }),
    "--strict-json",
  ]);
  await claw([
    "config",
    "set",
    "agents.defaults.model.primary",
    `sovereign/${b.model.id}`,
  ]);
  await exec("docker", ["restart", "openclaw"]);
  return { ok: true };
});
app.post("/internal/suspend", async () => {
  db.prepare(
    "INSERT OR REPLACE INTO settings VALUES('suspended','true')",
  ).run();
  await exec(
    "flock",
    ["-w", "120", "/var/lib/sac/locks/operation", "docker", "stop", "openclaw"],
    { timeout: 180000 },
  );
  return { ok: true };
});
app.post("/internal/resume", async () => {
  await exec(
    "flock",
    [
      "-w",
      "120",
      "/var/lib/sac/locks/operation",
      "docker",
      "start",
      "openclaw",
    ],
    { timeout: 180000 },
  );
  db.prepare(
    "INSERT OR REPLACE INTO settings VALUES('suspended','false')",
  ).run();
  return { ok: true };
});
app.post("/internal/ssh-key", async (req) => {
  const { publicKey, sourceIp } = z
    .object({
      publicKey: z
        .string()
        .regex(/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}(?: [^\r\n]+)?$/)
        .max(1000),
      sourceIp: z.string().refine((v) => isIP(v) === 4),
    })
    .parse(req.body);
  await appendFile("/host-ssh/authorized_keys", `\n${publicKey}\n`, {
    mode: 0o600,
  });
  await appendFile("/var/lib/sac/ssh-cidrs", `${sourceIp}/32\n`, {
    mode: 0o600,
  });
  await exec("iptables", [
    "-I",
    "SAC-INPUT",
    "3",
    "-p",
    "tcp",
    "--dport",
    "22",
    "-s",
    `${sourceIp}/32`,
    "-j",
    "ACCEPT",
  ]);
  return { ok: true };
});
app.get("/api/local/info", async (req) => {
  const s = auth(req);
  return {
    action: s.action,
    gatewayToken: s.action === "access" ? b.gatewayToken : undefined,
    controlOrigin: b.controlOrigin,
    mode: b.mode,
  };
});
app.get("/api/local/devices", async (req) => {
  const s = auth(req);
  if (s.action !== "access")
    throw Object.assign(Error("FORBIDDEN"), { statusCode: 403 });
  const { stdout } = await claw(["devices", "list", "--json"]);
  const data = JSON.parse(stdout);
  const device = db
    .prepare("SELECT public_key FROM session_devices WHERE session_hash=?")
    .get(hash(req.cookies[TENANT_COOKIE]!));
  return {
    pending: (data.pending ?? []).filter(
      (p: any) =>
        p.publicKey === device?.public_key && Number(p.ts) >= s.created,
    ),
  };
});
app.post("/api/local/pair", async (req) => {
  const s = auth(req);
  if (s.action !== "access")
    throw Object.assign(Error("FORBIDDEN"), { statusCode: 403 });
  const { requestId, publicKey } = z
    .object({
      requestId: z.string().uuid(),
      publicKey: z.string().min(20).max(1000),
    })
    .parse(req.body);
  const data = JSON.parse((await claw(["devices", "list", "--json"])).stdout);
  const device = db
    .prepare("SELECT public_key FROM session_devices WHERE session_hash=?")
    .get(hash(req.cookies[TENANT_COOKIE]!));
  const pending = (data.pending ?? []).find(
    (p: any) =>
      p.requestId === requestId &&
      p.publicKey === publicKey &&
      publicKey === device?.public_key &&
      Number(p.ts) >= s.created,
  );
  if (!pending)
    throw Object.assign(Error("DEVICE_DOES_NOT_MATCH_THIS_SESSION"), {
      statusCode: 403,
    });
  await claw(["devices", "approve", requestId]);
  return { ok: true };
});
async function archive(recipient: string) {
  if (!/^age1[0-9a-z]{58}$/.test(recipient))
    throw Error("INVALID_AGE_RECIPIENT");
  const id = randomUUID(),
    file = `/var/lib/sac/exports/${id}.age`;
  await exec(
    "flock",
    [
      "-w",
      "120",
      "/var/lib/sac/locks/operation",
      "/app/deploy/export.sh",
      recipient,
      file,
    ],
    { timeout: 300000, maxBuffer: 10000 },
  );
  return { id, file };
}
app.post("/api/local/export", async (req) => {
  const s = auth(req);
  if (s.action !== "export" || Date.now() - s.created > 600000)
    throw Object.assign(Error("FRESH_EXPORT_HANDOFF_REQUIRED"), {
      statusCode: 403,
    });
  const out = await archive(s.recipient);
  db.prepare("INSERT INTO exports VALUES(?,?,?,?)").run(
    out.id,
    hash(req.cookies[TENANT_COOKIE]!),
    out.file,
    Date.now() + 600000,
  );
  return { url: `/exports/${out.id}` };
});
app.get("/exports/:id", async (req, reply) => {
  auth(req);
  const id = z
    .string()
    .uuid()
    .parse((req.params as any).id);
  const row = db
    .prepare("SELECT * FROM exports WHERE id=? AND session_hash=? AND expiry>?")
    .get(id, hash(req.cookies[TENANT_COOKIE]!), Date.now()) as any;
  if (!row) throw Object.assign(Error("EXPORT_EXPIRED"), { statusCode: 404 });
  reply
    .header("content-type", "application/octet-stream")
    .header(
      "content-disposition",
      `attachment; filename="agent-${b.tenantId}.tar.age"`,
    );
  return reply.send(createReadStream(row.path));
});
app.post("/internal/backup", async (_req, reply) => {
  const out = await archive(b.backupRecipient);
  reply.raw.on("close", () => void unlink(out.file).catch(() => {}));
  return reply
    .type("application/octet-stream")
    .send(createReadStream(out.file));
});
await app.register(staticFiles, {
  root: resolve("tenant-public"),
  prefix: "/sac-assets/",
});
for (const route of ["/handoff", "/setup", "/export"])
  app.get(route, async (_req, reply) => reply.sendFile("index.html"));
setInterval(() => {
  const rows = db
    .prepare("SELECT path FROM exports WHERE expiry<?")
    .all(Date.now());
  for (const row of rows) void unlink(String(row.path)).catch(() => {});
  db.prepare("DELETE FROM exports WHERE expiry<?").run(Date.now());
  db.prepare("DELETE FROM sessions WHERE expiry<?").run(Date.now());
  db.prepare(
    "DELETE FROM session_devices WHERE session_hash NOT IN (SELECT hash FROM sessions)",
  ).run();
}, 60000).unref();
await app.listen({ host: "127.0.0.1", port: 3080 });
