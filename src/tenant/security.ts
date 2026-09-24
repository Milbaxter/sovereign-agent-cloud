import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";

export const TENANT_COOKIE = "__Host-agent_session";

export function tenantSecurity(
  app: FastifyInstance,
  origin: string,
  managementKey: string,
) {
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff")
      .header("x-frame-options", "DENY");
    // Fastify decodes static route segments. Authorize the matched route,
    // never the raw URL: /%69nternal/status also matches /internal/status.
    if (req.routeOptions.url?.startsWith("/internal/")) {
      const supplied = Buffer.from(req.headers.authorization ?? ""),
        expected = Buffer.from(`Bearer ${managementKey}`);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw Object.assign(Error("UNAUTHORIZED"), { statusCode: 401 });
    } else if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      req.headers.origin !== origin
    ) {
      throw Object.assign(Error("ORIGIN_REJECTED"), { statusCode: 403 });
    }
  });
}
