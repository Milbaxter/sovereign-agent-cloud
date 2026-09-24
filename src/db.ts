import pg from "pg";
import { randomUUID } from "node:crypto";
export type DB = pg.Pool;
export type Tx = pg.PoolClient;
export function database(url: string) {
  return new pg.Pool({ connectionString: url, max: 12 });
}
export async function transaction<T>(
  db: DB,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}
export async function enqueue(
  tx: Pick<Tx, "query">,
  key: string,
  kind: string,
  payload: unknown,
) {
  await tx.query(
    "INSERT INTO jobs(id,key,kind,payload) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO NOTHING",
    [randomUUID(), key, kind, JSON.stringify(payload)],
  );
}
export async function incident(
  db: Pick<Tx, "query">,
  key: string,
  kind: string,
  tenantId: string | null = null,
  detail: unknown = {},
) {
  await db.query(
    "INSERT INTO incidents(id,key,kind,tenant_id,detail) VALUES($1,$2,$3,$4,$5) ON CONFLICT(key) DO NOTHING",
    [randomUUID(), key, kind, tenantId, JSON.stringify(detail)],
  );
}
export async function audit(
  db: Pick<Tx, "query">,
  account: string,
  tenant: string | null,
  action: string,
) {
  await db.query(
    "INSERT INTO audit(id,account_id,tenant_id,action) VALUES($1,$2,$3,$4)",
    [randomUUID(), account, tenant, action],
  );
}
