import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hash } from "./crypto.js";
import { reserve, settle } from "./ledger.js";
import type { DB } from "./db.js";
import type { Model } from "./config.js";
const requestSchema = z
  .object({
    model: z.string(),
    messages: z.array(z.record(z.string(), z.unknown())).min(1),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    parallel_tool_calls: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    reasoning_effort: z
      .enum(["none", "low", "medium", "high", "max"])
      .optional(),
    response_format: z.unknown().optional(),
    stream_options: z
      .object({ include_usage: z.boolean().optional() })
      .optional(),
  })
  .strict();
export class UsageStream {
  buffer = "";
  usage: any = null;
  push(text: string) {
    this.buffer += text;
    if (this.buffer.length > 2_000_000) throw Error("UPSTREAM_EVENT_TOO_LARGE");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;
    for (const line of lines)
      if (line.startsWith("data:")) {
        const value = line.slice(5).trim();
        if (value === "[DONE]") continue;
        try {
          const object = JSON.parse(value);
          if (object.usage) this.usage = object.usage;
        } catch {}
      }
  }
}
export function inference(app: FastifyInstance, db: DB, catalog: Model[]) {
  app.register(
    async (api) => {
      api.addHook("preHandler", async (req) => {
        const bearer = req.headers.authorization?.match(
          /^Bearer ([A-Za-z0-9_-]+)$/,
        )?.[1];
        const tenant =
          bearer &&
          (
            await db.query(
              "SELECT * FROM tenants WHERE inference_key_hash=$1 AND state IN ('awaiting_setup','ready') AND (paid_until>now() OR grace_until>now())",
              [hash(bearer)],
            )
          ).rows[0];
        if (!tenant)
          throw Object.assign(Error("INVALID_API_KEY"), { statusCode: 401 });
        (req as any).tenant = tenant;
      });
      api.get("/models", async (req) => ({
        object: "list",
        data: catalog
          .filter((m) => m.verified && m.id === (req as any).tenant.model_id)
          .map((m) => ({ id: m.id, object: "model", owned_by: m.provider })),
      }));
      api.post(
        "/chat/completions",
        { bodyLimit: 2_000_000 },
        async (req, reply) => {
          const body = requestSchema.parse(req.body),
            tenant = (req as any).tenant;
          const model = catalog.find(
            (m) =>
              m.id === body.model && m.verified && m.id === tenant.model_id,
          );
          if (!model)
            throw Object.assign(Error("MODEL_NOT_SELECTED"), {
              statusCode: 400,
            });
          const key = process.env[model.keyEnv];
          if (!key)
            throw Object.assign(Error("PROVIDER_UNAVAILABLE"), {
              statusCode: 503,
            });
          const maxOutput =
            body.max_completion_tokens ??
            body.max_tokens ??
            Math.min(4096, model.maxOutput);
          if (maxOutput > model.maxOutput)
            throw Object.assign(Error("OUTPUT_LIMIT"), { statusCode: 400 });
          const id = await reserve(
            db,
            tenant.account_id,
            tenant.id,
            model,
            maxOutput,
          );
          let usage: any = null,
            started = false;
          try {
            const payload: any = {
              ...body,
              model: model.upstreamModel,
              max_tokens: maxOutput,
            };
            delete payload.max_completion_tokens;
            if (body.stream) payload.stream_options = { include_usage: true };
            const response = await fetch(
              model.baseUrl.replace(/\/$/, "") + "/chat/completions",
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${key}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(180_000),
              },
            );
            if (!response.ok) {
              // Rejected HTTP requests are unbilled; ambiguous network failures remain unknown.
              if ([400, 401, 403, 404, 413, 422, 429].includes(response.status))
                usage = { prompt_tokens: 0, completion_tokens: 0 };
              throw Object.assign(Error("INFERENCE_PROVIDER_ERROR"), {
                statusCode: 502,
              });
            }
            if (!body.stream) {
              const data: any = await response.json();
              usage = data.usage;
              data.model = model.id;
              return data;
            }
            reply.hijack();
            started = true;
            reply.raw.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
              "x-accel-buffering": "no",
              "x-request-id": id,
            });
            const parser = new UsageStream(),
              decoder = new TextDecoder();
            if (!response.body) throw Error("EMPTY_UPSTREAM");
            for await (const chunk of response.body) {
              parser.push(decoder.decode(chunk, { stream: true }));
              // Keep collecting usage after a browser disconnect; never retry a partial generation.
              if (!reply.raw.destroyed) {
                if (reply.raw.writableLength > 2_000_000) reply.raw.destroy();
                else reply.raw.write(chunk);
              }
            }
            parser.push(decoder.decode() + "\n");
            usage = parser.usage;
            if (!reply.raw.destroyed) reply.raw.end();
          } catch (e) {
            if (started) {
              if (!reply.raw.destroyed) reply.raw.destroy();
            } else throw e;
          } finally {
            await settle(db, id, model, usage);
          }
        },
      );
    },
    { prefix: "/v1" },
  );
}
