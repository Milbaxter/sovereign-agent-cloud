import { database } from "../src/db.js";
const db = database(process.env.DATABASE_URL!);
try {
  const [tenants, jobs, incidents, heartbeat] = await Promise.all([
    db.query("SELECT state,count(*)::int FROM tenants GROUP BY state"),
    db.query(
      "SELECT kind,count(*)::int FROM jobs WHERE done_at IS NULL GROUP BY kind",
    ),
    db.query(
      "SELECT kind,count(*)::int FROM incidents WHERE resolved_at IS NULL GROUP BY kind",
    ),
    db.query(
      "SELECT seen_at,seen_at>now()-interval '10 minutes' AS fresh FROM worker_heartbeat WHERE name='worker'",
    ),
  ]);
  console.log(
    JSON.stringify(
      {
        tenants: tenants.rows,
        pendingJobs: jobs.rows,
        incidents: incidents.rows,
        worker: heartbeat.rows[0] ?? null,
      },
      null,
      2,
    ),
  );
  if (incidents.rows.length || !heartbeat.rows[0]?.fresh) process.exitCode = 1;
} finally {
  await db.end();
}
