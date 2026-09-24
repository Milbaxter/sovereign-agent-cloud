import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { generateKeyPairSync, randomBytes } from "node:crypto";
await mkdir("secrets", { recursive: true, mode: 0o700 });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
await writeFile(
  "secrets/handoff-private.pem",
  privateKey.export({ type: "pkcs8", format: "pem" }),
  { mode: 0o600, flag: "wx" },
);
await writeFile(
  "secrets/handoff-public.pem",
  publicKey.export({ type: "spki", format: "pem" }),
  { mode: 0o644, flag: "wx" },
);
const password = randomBytes(32).toString("hex"),
  key = randomBytes(32).toString("base64");
let env = await readFile(".env.example", "utf8");
env = env
  .replaceAll("REPLACE_WITH_GENERATED_PASSWORD", password)
  .replace("REPLACE_WITH_32_RANDOM_BYTES_BASE64", key);
await writeFile(".env", env, { mode: 0o600, flag: "wx" });
console.log(
  "Created ignored .env and secrets/. Existing files are never overwritten.",
);
