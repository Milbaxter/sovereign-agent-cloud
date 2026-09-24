import { config, models } from "./config.js";
import { database } from "./db.js";
import { buildApp } from "./app.js";
const c = config(),
  db = database(c.DATABASE_URL),
  app = await buildApp(c, db, models(c));
await app.listen({ host: "0.0.0.0", port: c.PORT });
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void app.close().then(() => db.end());
  });
