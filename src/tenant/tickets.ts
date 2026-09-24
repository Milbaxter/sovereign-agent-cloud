import type { DatabaseSync } from "node:sqlite";
import { jwtVerify, importSPKI } from "jose";
import { token, hash } from "../crypto.js";
export async function consumeTicket(
  db: DatabaseSync,
  key: string,
  ticket: string,
  tenantId: string,
  origin: string,
) {
  const { payload } = await jwtVerify(ticket, await importSPKI(key, "EdDSA"), {
    issuer: "sovereign-agent-cloud",
    audience: origin,
    algorithms: ["EdDSA"],
    maxTokenAge: "65s",
  });
  if (
    payload.tenantId !== tenantId ||
    !payload.jti ||
    !["access", "export"].includes(String(payload.action))
  )
    throw Object.assign(Error("INVALID_HANDOFF"), { statusCode: 403 });
  const sid = token();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM tickets WHERE expiry<?").run(Date.now() - 60000);
    db.prepare("INSERT INTO tickets VALUES(?,?)").run(
      payload.jti,
      Number(payload.exp) * 1000,
    );
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
      hash(sid),
      Date.now(),
      Date.now() + 3600000,
      String(payload.action),
      String(payload.recipient ?? ""),
    );
    db.exec("COMMIT");
  } catch {
    db.exec("ROLLBACK");
    throw Object.assign(Error("HANDOFF_ALREADY_USED"), { statusCode: 403 });
  }
  return { sid, action: payload.action };
}
