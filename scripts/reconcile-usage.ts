import { readFile } from "node:fs/promises";
import { z } from "zod";
import { config, models, modelSchema } from "../src/config.js";
import { database } from "../src/db.js";
import { settle } from "../src/ledger.js";

// Operator-only: input must come from the provider's billing/usage records.
// For a confirmed unbilled request, supply zero counters and its evidence ID.
const id = z.string().uuid().parse(process.argv[2]);
const path = z.string().min(1).parse(process.argv[3]);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const input = z
  .object({
    evidence: z.string().trim().min(1).max(1000),
    usage: z
      .object({
        prompt_tokens: counter,
        completion_tokens: counter,
        prompt_tokens_details: z.object({ cached_tokens: counter }).optional(),
        completion_tokens_details: z
          .object({ reasoning_tokens: counter })
          .optional(),
      })
      .strict(),
  })
  .strict()
  .parse(JSON.parse(await readFile(path, "utf8")));
const c = config(),
  db = database(c.DATABASE_URL);
try {
  const r = (await db.query("SELECT * FROM requests WHERE id=$1", [id]))
    .rows[0];
  if (!r) throw Error("REQUEST_NOT_FOUND");
  const model = r.rates
    ? modelSchema.parse(r.rates)
    : models(c).find(
        (m) => m.id === r.model_id && m.rateVersion === r.rate_version,
      );
  if (!model) throw Error("ORIGINAL_RATE_VERSION_REQUIRED");
  await settle(db, id, model, input.usage, input.evidence);
  const result = (
    await db.query("SELECT state FROM requests WHERE id=$1", [id])
  ).rows[0];
  if (result.state !== "settled") throw Error("RECONCILIATION_REQUIRES_REVIEW");
  console.log("Usage reconciled; only verified usage was charged.");
} finally {
  await db.end();
}
