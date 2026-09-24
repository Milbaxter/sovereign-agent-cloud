import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { z } from "zod";
import { hash, token } from "./crypto.js";
import { transaction, type DB } from "./db.js";
import type { Config } from "./config.js";
export const PORTAL_COOKIE = "__Host-session";
export type Identity = { accountId: string; createdAt: Date };
export async function identity(
  req: FastifyRequest,
  db: DB,
  fresh = false,
): Promise<Identity> {
  const sid = req.cookies[PORTAL_COOKIE];
  const row =
    sid &&
    (
      await db.query(
        "SELECT * FROM sessions WHERE hash=$1 AND expires_at>now()",
        [hash(sid)],
      )
    ).rows[0];
  if (!row) throw Object.assign(Error("LOGIN_REQUIRED"), { statusCode: 401 });
  if (fresh && Date.now() - new Date(row.created_at).getTime() > 10 * 60_000)
    throw Object.assign(Error("FRESH_LOGIN_REQUIRED"), { statusCode: 403 });
  return { accountId: row.account_id, createdAt: row.created_at };
}
export function auth(app: FastifyInstance, db: DB, c: Config) {
  app.post(
    "/api/auth/request",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const body = z
        .object({
          email: z.string().trim().email().max(254),
          mode: z.enum(["byok", "credits"]).optional(),
        })
        .parse(req.body);
      const email = body.email.toLowerCase();
      if (c.TEST_ACCOUNT_EMAIL && email !== c.TEST_ACCOUNT_EMAIL.toLowerCase())
        throw Object.assign(Error("TEST_ACCOUNT_ONLY"), { statusCode: 403 });
      if (!c.SMTP_URL)
        throw Object.assign(Error("EMAIL_UNAVAILABLE"), { statusCode: 503 });
      const secret = token();
      await transaction(db, async (tx) => {
        const account = (
          await tx.query(
            "INSERT INTO accounts(id,email) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id",
            [randomUUID(), email],
          )
        ).rows[0];
        await tx.query(
          "INSERT INTO login_tokens(hash,account_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')",
          [hash(secret), account.id],
        );
      });
      const signInUrl = new URL("/", c.PUBLIC_ORIGIN);
      if (body.mode) signInUrl.searchParams.set("mode", body.mode);
      signInUrl.hash = `login=${secret}`;
      // Fragment is not sent to HTTP servers, mail-link scanners, or access logs.
      await nodemailer.createTransport(c.SMTP_URL).sendMail({
        from: c.EMAIL_FROM,
        to: email,
        subject: "Sign in to Your Agent",
        text: `Open ${signInUrl}\nThis single-use link expires in 15 minutes. If you did not request it, ignore this email.`,
      });
      return reply
        .code(202)
        .send({ message: "Check your email for a sign-in link." });
    },
  );
  app.post("/api/auth/consume", async (req, reply) => {
    const secret = z
        .object({ token: z.string().min(40).max(100) })
        .parse(req.body).token,
      session = token();
    await transaction(db, async (tx) => {
      const row = (
        await tx.query(
          "DELETE FROM login_tokens WHERE hash=$1 AND expires_at>now() RETURNING account_id",
          [hash(secret)],
        )
      ).rows[0];
      if (!row)
        throw Object.assign(Error("EXPIRED_LOGIN_LINK"), { statusCode: 401 });
      await tx.query(
        "INSERT INTO sessions(hash,account_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
        [hash(session), row.account_id],
      );
    });
    reply.setCookie(PORTAL_COOKIE, session, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 7 * 86400,
    });
    return { ok: true };
  });
  app.post("/api/auth/logout", async (req, reply) => {
    if (req.cookies[PORTAL_COOKIE])
      await db.query("DELETE FROM sessions WHERE hash=$1", [
        hash(req.cookies[PORTAL_COOKIE]),
      ]);
    reply.clearCookie(PORTAL_COOKIE, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
    });
    return { ok: true };
  });
}
