import { readdir, readFile } from "node:fs/promises";
import { database, transaction, type DB } from "./db.js";
export async function migrate(db: DB) {
  await db.query(
    "CREATE TABLE IF NOT EXISTS migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of (await readdir("migrations"))
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    await transaction(db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(113921)");
      if (
        (await tx.query("SELECT 1 FROM migrations WHERE name=$1", [name]))
          .rowCount
      )
        return;
      await tx.query(await readFile(`migrations/${name}`, "utf8"));
      await tx.query("INSERT INTO migrations(name) VALUES($1)", [name]);
    });
  }
}
if (
  process.argv[1]?.endsWith("migrate.ts") ||
  process.argv[1]?.endsWith("migrate.js")
) {
  const db = database(process.env.DATABASE_URL!);
  await migrate(db);
  await db.end();
}
