import { config, models } from "./config.js";
import { database } from "./db.js";
import { Worker } from "./worker.js";
import { setTimeout } from "node:timers/promises";
const c = config(),
  db = database(c.DATABASE_URL),
  worker = new Worker(db, c, models(c));
let running = true,
  lastMaintenance = 0;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    running = false;
  });
while (running) {
  try {
    await db.query(
      "INSERT INTO worker_heartbeat(name,seen_at) VALUES('worker',now()) ON CONFLICT(name) DO UPDATE SET seen_at=now()",
    );
    if (Date.now() - lastMaintenance > 300000) {
      await worker.maintenance();
      lastMaintenance = Date.now();
    }
    if (!(await worker.tick())) await setTimeout(2000);
  } catch {
    console.error("WORKER_CYCLE_FAILED");
    await setTimeout(5000);
  }
}
await db.end();
