import type { DatabaseSync } from "node:sqlite";
import { hash } from "../crypto.js";

export function tenantSession(db: DatabaseSync, sid?: string) {
  const row =
    sid &&
    db
      .prepare("SELECT * FROM sessions WHERE hash=? AND expiry>?")
      .get(hash(sid), Date.now());
  if (!row)
    throw Object.assign(Error("SIGN_IN_FROM_YOUR_ACCOUNT"), {
      statusCode: 401,
    });
  if (
    row.action === "access" &&
    db.prepare("SELECT value FROM settings WHERE key='suspended'").get()
      ?.value === "true"
  ) {
    throw Object.assign(Error("AGENT_SUSPENDED"), { statusCode: 403 });
  }
  return row;
}
