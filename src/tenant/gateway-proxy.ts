import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { hash } from "../crypto.js";
import { TENANT_COOKIE } from "./security.js";
// Only connection metadata is inspected. Conversation frames are forwarded, never persisted.
export function deviceFromConnect(data: string): string | null {
  try {
    const v = JSON.parse(data);
    const key = v?.params?.device?.publicKey;
    return v.type === "req" &&
      v.method === "connect" &&
      typeof key === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(key)
      ? key
      : null;
  } catch {
    return null;
  }
}
export function gatewayProxy(
  app: FastifyInstance,
  db: DatabaseSync,
  origin: string,
) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS session_devices(session_hash TEXT PRIMARY KEY,public_key TEXT NOT NULL)",
  );
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
  });
  app.server.on("upgrade", (request, socket, head) => {
    const cookie = app.parseCookie(request.headers.cookie ?? ""),
      sid = cookie[TENANT_COOKIE],
      sessionHash = sid ? hash(sid) : "";
    const session = db
      .prepare(
        "SELECT * FROM sessions WHERE hash=? AND expiry>? AND action='access'",
      )
      .get(sessionHash, Date.now());
    const suspended =
      db.prepare("SELECT value FROM settings WHERE key='suspended'").get()
        ?.value === "true";
    if (!session || suspended || request.headers.origin !== origin) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      // The upstream handshake retains its actual Origin and loopback source.
      const upstream = new WebSocket("ws://127.0.0.1:18789/", {
        origin,
        maxPayload: 16 * 1024 * 1024,
      });
      const pending: { data: RawData; binary: boolean }[] = [];
      let pendingBytes = 0;
      client.on("message", (data, binary) => {
        if (!binary) {
          const key = deviceFromConnect(data.toString());
          if (key) {
            const prior = db
              .prepare(
                "SELECT public_key FROM session_devices WHERE session_hash=?",
              )
              .get(sessionHash);
            if (prior && prior.public_key !== key) {
              client.close(1008, "Session already bound to a device");
              return;
            }
            db.prepare("INSERT OR IGNORE INTO session_devices VALUES(?,?)").run(
              sessionHash,
              key,
            );
          }
        }
        if (upstream.readyState === WebSocket.OPEN) {
          if (upstream.bufferedAmount > 16 * 1024 * 1024) {
            client.terminate();
            return;
          }
          upstream.send(data, { binary });
        } else {
          pendingBytes += data.toString().length;
          if (pendingBytes > 65536) {
            client.close(1009);
            return;
          }
          pending.push({ data, binary });
        }
      });
      upstream.on("open", () => {
        for (const p of pending) upstream.send(p.data, { binary: p.binary });
        pending.length = 0;
      });
      upstream.on("message", (data, binary) => {
        if (client.readyState === WebSocket.OPEN) {
          if (client.bufferedAmount > 16 * 1024 * 1024) {
            client.terminate();
            return;
          }
          client.send(data, { binary });
        }
      });
      const expiry = setTimeout(
        () => client.close(1008, "Session expired"),
        Math.max(1, Number((session as any).expiry) - Date.now()),
      );
      expiry.unref();
      client.on("close", () => {
        clearTimeout(expiry);
        upstream.close();
      });
      upstream.on("close", () => client.close());
      client.on("error", () => upstream.terminate());
      upstream.on("error", () => client.close(1011, "Gateway unavailable"));
    });
  });
  app.addHook("onClose", async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
  });
}
