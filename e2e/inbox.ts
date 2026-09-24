import { secret, type Manifest } from "./config.js";

type Message = { id?: string; internalDate?: string; payload?: Part };
type Part = {
  mimeType?: string;
  body?: { data?: string };
  headers?: { name: string; value: string }[];
  parts?: Part[];
};
function textParts(part?: Part): string[] {
  if (!part) return [];
  const own =
    part.mimeType === "text/plain" && part.body?.data
      ? [Buffer.from(part.body.data, "base64url").toString("utf8")]
      : [];
  return [...own, ...(part.parts ?? []).flatMap(textParts)];
}
// Match delivered mail to this fresh origin, recipient, mode and request time.
// Do not read login_tokens or a sender-side email log as a substitute for delivery.
export function loginLink(
  message: Message,
  m: Pick<Manifest, "origin" | "mode">,
  email: string,
  since: number,
): string | undefined {
  if (!message.internalDate || Number(message.internalDate) < since - 2000)
    return;
  const header = (name: string) =>
    message.payload?.headers?.find((h) => h.name.toLowerCase() === name)
      ?.value ?? "";
  if (header("subject") !== "Sign in to Your Agent") return;
  const addresses: string[] =
    header("to")
      .toLowerCase()
      .match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/g) ?? [];
  if (!addresses.includes(email.toLowerCase())) return;
  const links = textParts(message.payload).flatMap(
    (text) => text.match(/https:\/\/[^\s<>]+/g) ?? [],
  );
  const valid = links.filter((value) => {
    try {
      const u = new URL(value),
        fragment = new URLSearchParams(u.hash.slice(1));
      return (
        u.origin === m.origin &&
        u.pathname === "/" &&
        u.searchParams.get("mode") === m.mode &&
        !u.username &&
        !u.password &&
        /^[A-Za-z0-9_-]{40,100}$/.test(fragment.get("login") ?? "")
      );
    } catch {
      return false;
    }
  });
  if (valid.length === 1) return valid[0];
}
export class GmailInbox {
  private token = "";
  private expires = 0;
  private async accessToken() {
    if (Date.now() < this.expires) return this.token;
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: secret("GMAIL_CLIENT_ID"),
        client_secret: secret("GMAIL_CLIENT_SECRET"),
        refresh_token: secret("GMAIL_REFRESH_TOKEN"),
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw Error(`GMAIL_AUTH_${response.status}`);
    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) throw Error("GMAIL_ACCESS_TOKEN_MISSING");
    this.token = body.access_token;
    this.expires =
      Date.now() + Math.max(0, (body.expires_in ?? 300) - 60) * 1000;
    return this.token;
  }
  private async get(path: string) {
    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
      {
        headers: { authorization: `Bearer ${await this.accessToken()}` },
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) throw Error(`GMAIL_READ_${response.status}`);
    return response.json();
  }
  async verifyIdentity() {
    const profile = (await this.get("profile")) as { emailAddress?: string };
    if (
      profile.emailAddress?.toLowerCase() !==
      secret("TEST_ACCOUNT_EMAIL").toLowerCase()
    )
      throw Error("INBOX_ACCOUNT_MISMATCH");
  }
  async waitForLogin(
    m: Manifest,
    since: number,
  ): Promise<{ url: string; messageId: string; deliveryMs: number }> {
    const email = secret("TEST_ACCOUNT_EMAIL"),
      deadline = Date.now() + 120000;
    // No inbox contents or URLs are logged or attached to test artifacts.
    while (Date.now() < deadline) {
      const query = new URLSearchParams({
        q: `to:${email} subject:"Sign in to Your Agent" after:${Math.floor(since / 1000) - 2}`,
        includeSpamTrash: "true",
        maxResults: "20",
      });
      const list = (await this.get(`messages?${query}`)) as {
        messages?: { id: string }[];
      };
      for (const entry of list.messages ?? []) {
        const message = (await this.get(
          `messages/${encodeURIComponent(entry.id)}?format=full`,
        )) as Message;
        const url = loginLink(message, m, email, since);
        if (url)
          return {
            url,
            messageId: entry.id,
            deliveryMs: Number(message.internalDate) - since,
          };
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw Error("SIGNUP_EMAIL_NOT_DELIVERED");
  }
}
