import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
export const token = () => randomBytes(32).toString("base64url");
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function seal(value: string, key: string) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  return Buffer.concat([
    iv,
    c.update(value),
    c.final(),
    c.getAuthTag(),
  ]).toString("base64");
}
export function unseal(value: string, key: string) {
  const b = Buffer.from(value, "base64"),
    d = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "base64"),
      b.subarray(0, 12),
    );
  d.setAuthTag(b.subarray(-16));
  return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString();
}
export async function handoff(
  privateKey: string,
  tenantId: string,
  origin: string,
  action = "access",
  recipient?: string,
) {
  return new SignJWT({ tenantId, action, recipient })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer("sovereign-agent-cloud")
    .setAudience(origin)
    .setJti(token())
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(await importPKCS8(privateKey, "EdDSA"));
}
