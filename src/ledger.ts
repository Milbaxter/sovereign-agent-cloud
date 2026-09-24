import { randomUUID } from "node:crypto";
import { transaction, incident, type DB, type Tx } from "./db.js";
import type { Model } from "./config.js";
export const MICRO_EUR = 1_000_000n;
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
export function price(model: Model, input: number, output: number, cached = 0) {
  if (
    ![input, output, cached].every(Number.isSafeInteger) ||
    cached > input ||
    cached < 0 ||
    input < 0 ||
    output < 0
  )
    throw Error("INVALID_USAGE");
  return ceil(
    (BigInt(input - cached) * model.inputMicroEurPerMillion +
      BigInt(cached) * model.cachedMicroEurPerMillion +
      BigInt(output) * model.outputMicroEurPerMillion) *
      125n,
    100n * 1_000_000n,
  );
}
export function maximumPrice(model: Model, output: number) {
  return price(
    {
      ...model,
      inputMicroEurPerMillion:
        model.inputMicroEurPerMillion > model.cachedMicroEurPerMillion
          ? model.inputMicroEurPerMillion
          : model.cachedMicroEurPerMillion,
    },
    model.maxContext,
    output,
  );
}
export async function credit(
  tx: Tx,
  account: string,
  source: string,
  amount: bigint,
) {
  if (amount <= 0n) throw Error("INVALID_CREDIT");
  await tx.query(
    "INSERT INTO wallets(account_id) VALUES($1) ON CONFLICT DO NOTHING",
    [account],
  );
  const w = (
    await tx.query("SELECT * FROM wallets WHERE account_id=$1 FOR UPDATE", [
      account,
    ])
  ).rows[0];
  const added = await tx.query(
    "INSERT INTO ledger(id,account_id,source,amount,kind) VALUES($1,$2,$3,$4,'topup') ON CONFLICT(source) DO NOTHING RETURNING id",
    [randomUUID(), account, source, amount.toString()],
  );
  if (!added.rowCount) return;
  const debt = BigInt(w.debt),
    repaid = amount < debt ? amount : debt;
  await tx.query(
    "UPDATE wallets SET balance=balance+$2,debt=debt-$3 WHERE account_id=$1",
    [account, (amount - repaid).toString(), repaid.toString()],
  );
}
// Cumulative reversal target makes repeated refund and dispute events idempotent.
export async function reverseCredit(
  tx: Tx,
  account: string,
  order: string,
  target: bigint,
) {
  await tx.query("SELECT 1 FROM wallets WHERE account_id=$1 FOR UPDATE", [
    account,
  ]);
  await tx.query(
    "INSERT INTO credit_reversals(order_id) VALUES($1) ON CONFLICT DO NOTHING",
    [order],
  );
  const old = BigInt(
    (
      await tx.query(
        "SELECT reversed FROM credit_reversals WHERE order_id=$1 FOR UPDATE",
        [order],
      )
    ).rows[0].reversed,
  );
  if (target === old) return;
  const delta = target - old,
    w = (await tx.query("SELECT * FROM wallets WHERE account_id=$1", [account]))
      .rows[0];
  if (delta > 0n) {
    const available = BigInt(w.balance),
      taken = delta < available ? delta : available;
    await tx.query(
      "UPDATE wallets SET balance=balance-$2,debt=debt+$3 WHERE account_id=$1",
      [account, taken.toString(), (delta - taken).toString()],
    );
  } else {
    const returned = -delta,
      debt = BigInt(w.debt),
      repaid = returned < debt ? returned : debt;
    await tx.query(
      "UPDATE wallets SET balance=balance+$2,debt=debt-$3 WHERE account_id=$1",
      [account, (returned - repaid).toString(), repaid.toString()],
    );
  }
  await tx.query(
    "INSERT INTO ledger(id,account_id,source,amount,kind) VALUES($1,$2,$3,$4,'reversal')",
    [
      randomUUID(),
      account,
      `reversal:${order}:${randomUUID()}`,
      (-delta).toString(),
    ],
  );
  await tx.query("UPDATE credit_reversals SET reversed=$2 WHERE order_id=$1", [
    order,
    target.toString(),
  ]);
}
export async function reserve(
  db: DB,
  account: string,
  tenant: string,
  model: Model,
  maxOutput: number,
) {
  const amount = maximumPrice(model, maxOutput),
    id = randomUUID();
  await transaction(db, async (tx) => {
    const w = (
      await tx.query("SELECT * FROM wallets WHERE account_id=$1 FOR UPDATE", [
        account,
      ])
    ).rows[0];
    if (
      !w ||
      BigInt(w.debt) > 0n ||
      BigInt(w.balance) - BigInt(w.reserved) < amount
    )
      throw Object.assign(Error("INSUFFICIENT_CREDIT"), { statusCode: 402 });
    await tx.query(
      "UPDATE wallets SET reserved=reserved+$2 WHERE account_id=$1",
      [account, amount.toString()],
    );
    await tx.query(
      "INSERT INTO requests(id,account_id,tenant_id,model_id,rate_version,reserved) VALUES($1,$2,$3,$4,$5,$6)",
      [id, account, tenant, model.id, model.rateVersion, amount.toString()],
    );
  });
  return id;
}
export async function settle(
  db: DB,
  id: string,
  model: Model,
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null,
) {
  await transaction(db, async (tx) => {
    const r = (
      await tx.query("SELECT * FROM requests WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!r || !["reserved", "unknown"].includes(r.state)) return;
    if (!usage) {
      await tx.query("UPDATE requests SET state='unknown' WHERE id=$1", [id]);
      await incident(tx, `usage:${id}`, "missing_usage", r.tenant_id, {
        requestId: id,
      });
      return;
    }
    let charged: bigint;
    try {
      charged = price(
        model,
        usage.prompt_tokens,
        usage.completion_tokens,
        usage.prompt_tokens_details?.cached_tokens ?? 0,
      );
    } catch {
      await tx.query("UPDATE requests SET state='unknown' WHERE id=$1", [id]);
      await incident(tx, `usage:${id}`, "invalid_usage", r.tenant_id, {
        requestId: id,
      });
      return;
    }
    if (
      (usage.completion_tokens_details?.reasoning_tokens ?? 0) >
        usage.completion_tokens ||
      charged > BigInt(r.reserved)
    ) {
      await tx.query("UPDATE requests SET state='unknown' WHERE id=$1", [id]);
      await incident(
        tx,
        `usage:${id}`,
        "usage_exceeds_reservation",
        r.tenant_id,
        { requestId: id },
      );
      return;
    }
    const w = (
      await tx.query("SELECT * FROM wallets WHERE account_id=$1 FOR UPDATE", [
        r.account_id,
      ])
    ).rows[0];
    const paid = charged < BigInt(w.balance) ? charged : BigInt(w.balance);
    await tx.query(
      "UPDATE wallets SET balance=balance-$2,reserved=reserved-$3,debt=debt+$4 WHERE account_id=$1",
      [r.account_id, paid.toString(), r.reserved, (charged - paid).toString()],
    );
    await tx.query(
      "INSERT INTO ledger(id,account_id,source,amount,kind,metadata) VALUES($1,$2,$3,$4,'usage',$5) ON CONFLICT(source) DO NOTHING",
      [
        randomUUID(),
        r.account_id,
        `request:${id}`,
        (-charged).toString(),
        JSON.stringify({
          model: model.id,
          rateVersion: model.rateVersion,
          usage,
        }),
      ],
    );
    await tx.query(
      "UPDATE requests SET state='settled',charged=$2,usage=$3 WHERE id=$1",
      [id, charged.toString(), JSON.stringify(usage)],
    );
  });
}
export async function releaseUnknown(db: DB) {
  const rows = (
    await db.query(
      "SELECT id FROM requests WHERE state IN ('reserved','unknown') AND created_at<now()-interval '24 hours'",
    )
  ).rows;
  for (const { id } of rows)
    await transaction(db, async (tx) => {
      const r = (
        await tx.query("SELECT * FROM requests WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!["reserved", "unknown"].includes(r.state)) return;
      await tx.query(
        "UPDATE wallets SET reserved=reserved-$2 WHERE account_id=$1",
        [r.account_id, r.reserved],
      );
      await tx.query(
        "UPDATE requests SET state='waived',charged=0 WHERE id=$1",
        [id],
      );
      await incident(
        tx,
        `waived:${id}`,
        "unreconciled_usage_waived",
        r.tenant_id,
        { requestId: id },
      );
    });
}
