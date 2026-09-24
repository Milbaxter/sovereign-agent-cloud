import { readFileSync } from "node:fs";
import { z } from "zod";

const origin = z
  .string()
  .url()
  .refine((value) => {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      u.hostname.endsWith(".sslip.io") &&
      !u.username &&
      !u.password &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash
    );
  }, "An owned temporary HTTPS origin is required");
export const manifestSchema = z
  .object({
    runId: z.string().regex(/^journey-[a-z0-9-]{8,60}$/),
    mode: z.enum(["byok", "credits"]),
    origin,
    controlId: z.uuid(),
    controlIp: z.ipv4(),
    controlHostname: z.string().regex(/^journey-[a-z0-9-]+$/),
    tenantDomain: z.string().regex(/^journey-[a-z0-9-]+\.invalid$/),
    hostingPrice: z.string().startsWith("price_"),
    creditPrice: z.string().startsWith("price_"),
    webhookId: z.string().startsWith("we_"),
    runtimeImage: z
      .string()
      .regex(
        /^ghcr\.io\/milbaxter\/sovereign-agent-cloud:sha-[a-f0-9]{40}@sha256:[a-f0-9]{64}$/,
      ),
    openclawImage: z.literal(
      "ghcr.io/openclaw/openclaw:2026.9.6-browser@sha256:62832668e3e5e139f745f7d3df892c9251eb53318b7d14a76c410dde1f25d730",
    ),
    model: z.literal("gpt-4.1-mini-2025-04-14"),
    modelId: z.literal("openai-journey"),
    markerUrl: z.string().url(),
    marker: z.string().regex(/^JOURNEY_[A-F0-9]{32}$/),
    createdAt: z.iso.datetime(),
  })
  .superRefine((m, ctx) => {
    const expected = `control.${m.controlIp.replaceAll(".", "-")}.sslip.io`;
    if (
      new URL(m.origin).hostname !== expected ||
      m.controlHostname !== m.runId ||
      m.tenantDomain !== `${m.runId}.invalid`
    )
      ctx.addIssue({ code: "custom", message: "Run ownership mismatch" });
    if (
      new URL(m.markerUrl).origin !== m.origin ||
      new URL(m.markerUrl).pathname !== "/journey-marker"
    )
      ctx.addIssue({
        code: "custom",
        message: "Marker must be on this run's control server",
      });
  });
export type Manifest = z.infer<typeof manifestSchema>;
export function manifest(): Manifest {
  if (!process.env.JOURNEY_MANIFEST) throw Error("JOURNEY_MANIFEST_REQUIRED");
  return manifestSchema.parse(
    JSON.parse(readFileSync(process.env.JOURNEY_MANIFEST, "utf8")),
  );
}
export function secret(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw Error(`${name}_REQUIRED`);
  return value.trim();
}
