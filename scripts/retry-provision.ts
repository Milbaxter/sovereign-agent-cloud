import { config } from "../src/config.js";
import { database, transaction, audit } from "../src/db.js";
import { UpCloud } from "../src/providers/upcloud.js";
import { z } from "zod";
const id = z.string().uuid().parse(process.argv[2]),
  confirmed = process.argv.includes("--confirmed-no-provider-resource"),
  c = config(),
  db = database(c.DATABASE_URL);
try {
  const t = (await db.query("SELECT * FROM tenants WHERE id=$1", [id])).rows[0];
  if (!t) throw Error("NOT_FOUND");
  const found = await new UpCloud(c).find(t.hostname);
  if (!found && t.create_attempted_at && !confirmed)
    throw Error(
      "Inspect provider audit history, then explicitly pass --confirmed-no-provider-resource",
    );
  if (found)
    await db.query("UPDATE tenants SET provider_id=$2 WHERE id=$1", [
      id,
      found.uuid,
    ]);
  await transaction(db, async (tx) => {
    if (!found && confirmed)
      await tx.query(
        "UPDATE tenants SET create_attempted_at=NULL,bootstrap_hash=NULL,bundle_cipher=NULL WHERE id=$1",
        [id],
      );
    await tx.query(
      "UPDATE tenants SET state='provisioning',error_code=NULL WHERE id=$1 AND state IN ('failed','provisioning')",
      [id],
    );
    await tx.query(
      "UPDATE jobs SET attempts=0,available_at=now(),lease_until=NULL,done_at=NULL WHERE key=$1",
      [`provision:${id}`],
    );
    await audit(
      tx,
      t.account_id,
      id,
      found
        ? "operator_adopted_provider_vm"
        : "operator_confirmed_no_provider_vm",
    );
  });
  console.log("Provision job requeued; no VM was created by this command.");
} finally {
  await db.end();
}
