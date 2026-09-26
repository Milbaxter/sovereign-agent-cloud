import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

class Element {
  children: Element[] = [];
  value = "";
  hidden = false;
  disabled = false;
  textContent = "";
  name = "";
  attributes = new Map<string, string>();
  get tagName() {
    return this.tag.toUpperCase();
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  querySelectorAll(tag: string): Element[] {
    return this.children.flatMap((child) => [
      ...(child.tag === tag ? [child] : []),
      ...child.querySelectorAll(tag),
    ]);
  }
  onclick?: (event?: any) => Promise<void>;
  constructor(readonly tag = "div") {}
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
}

async function portal(state: string, search = "") {
  const nodes = new Map<string, Element>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id)!;
  };
  get("#mode").value = "byok";
  const calls: { path: string; body: any }[] = [];
  let polling: (() => void) | undefined;
  const customer = {
    email: "owner@example.test",
    wallet: { balance: 0, reserved: 0, debt: 0 },
    tenants: [
      {
        id: "tenant",
        state,
        mode: "credits",
        model_id: "model",
        paid_until: "2099-01-01",
      },
    ],
  };
  const context = {
    document: {
      querySelector: get,
      createElement: (tag: string) => new Element(tag),
    },
    location: { search, hash: "", pathname: "/", assign: () => {} },
    history: { replaceState: () => {} },
    URLSearchParams,
    AbortSignal,
    confirm: () => true,
    clearTimeout: () => {
      polling = undefined;
    },
    setTimeout: (callback: () => void) => {
      polling = callback;
      return 1;
    },
    fetch: async (path: string, options: any) => {
      calls.push({
        path,
        body: options?.body ? JSON.parse(options.body) : undefined,
      });
      return {
        ok: true,
        json: async () =>
          path === "/api/me"
            ? customer
            : path === "/api/catalog"
              ? {
                  checkoutEnabled: true,
                  creditsEnabled: true,
                  models: [{ id: "model", country: "France" }],
                }
              : { ok: true },
      };
    },
  };
  await runInNewContext(await readFile("public/app.js", "utf8"), context);
  return { get, calls, context, customer, polling: () => polling };
}

test("account polling preserves partially entered export and SSH forms", async () => {
  const page = await portal("awaiting_setup");
  const section = page.get("#agent").children[0];
  const exportForm = section.children.find(
    (element) => element.tag === "form",
  )!;
  const input = exportForm.children[0].children[0];
  input.value = "age1-partially-entered";
  assert.ok(page.polling());
  await runInNewContext("refresh()", page.context);
  assert.equal(page.get("#agent").children[0], section);
  assert.equal(input.value, "age1-partially-entered");
  page.customer.tenants[0].state = "ready";
  await runInNewContext("refresh()", page.context);
  assert.notEqual(page.get("#agent").children[0], section);
  assert.equal(
    page.get("#agent").querySelectorAll("input")[0].value,
    "age1-partially-entered",
  );
  assert.equal(page.polling(), undefined);
});

test("pending payment keeps polling and displays the frozen checkout selection", async () => {
  const page = await portal("pending_payment", "?mode=byok");
  assert.ok(page.polling());
  assert.equal(page.get("#mode").value, "credits");
  assert.equal(page.get("#model").value, "model");
  assert.equal(page.get("#mode").disabled, true);
  page.customer.tenants[0].state = "provisioning";
  await runInNewContext("refresh()", page.context);
  assert.equal(page.get("#purchase").hidden, true);
});

test("signed-in users can request fresh authentication without signing out", async () => {
  const page = await portal("ready", "?mode=credits");
  assert.equal(page.get("#login").hidden, true);
  await page.get("#reauth").onclick!();
  assert.deepEqual(page.calls.at(-1), {
    path: "/api/auth/request",
    body: { email: "owner@example.test", mode: "credits" },
  });
  assert.match(page.get("#notice").textContent, /Check your email/);
});

test("suspended owners see offline retention guidance and no unusable export action", async () => {
  const page = await portal("suspended");
  const section = page.get("#agent").children[0];
  assert.ok(
    section.children.some((e) => /server is offline/.test(e.textContent)),
  );
  const forms = section.children.filter((e) => e.tag === "form");
  assert.equal(
    forms[0].children.find((e) => e.tag === "button")!.disabled,
    true,
  );
  assert.equal(
    forms[1].children.find((e) => e.tag === "button")!.disabled,
    true,
  );
});

test("wallet review explains why adding credit will not unlock inference", async () => {
  const page = await portal("ready");
  Object.assign(page.customer.wallet, { usageReviewRequired: true });
  await runInNewContext("refresh()", page.context);
  assert.match(
    page.get("#balance").textContent,
    /buying more credits will not clear/,
  );
});

test("temporary account failure preserves the session and entered forms, then polling recovers", async () => {
  const page = await portal("awaiting_setup");
  const section = page.get("#agent").children[0];
  const input = section.children.find((e) => e.tag === "form")!.children[0]
    .children[0];
  input.value = "age1-unsaved";
  const original = page.context.fetch;
  page.context.fetch = async (path, options) => {
    if (path === "/api/me") throw Error("offline");
    return original(path, options);
  };
  await runInNewContext("refresh()", page.context);
  assert.equal(page.get("#login").hidden, true);
  assert.equal(page.get("#agent").children[0], section);
  assert.equal(input.value, "age1-unsaved");
  assert.match(
    page.get("#connection").textContent,
    /Reconnecting automatically/,
  );
  assert.ok(page.polling());
  page.context.fetch = original;
  await page.polling()!();
  assert.equal(page.get("#connection").textContent, "");
  assert.equal(input.value, "age1-unsaved");
});

test("catalog outage retries instead of permanently stopping account updates", async () => {
  const page = await portal("provisioning");
  const original = page.context.fetch;
  page.context.fetch = async () => {
    throw Error("offline");
  };
  await runInNewContext("refresh()", page.context);
  assert.ok(page.polling());
  page.context.fetch = original;
  page.customer.tenants[0].state = "ready";
  await page.polling()!();
  assert.equal(page.get("#connection").textContent, "");
  assert.equal(page.polling(), undefined);
});

test("expired session returns to sign-in without treating it as a network outage", async () => {
  const page = await portal("awaiting_setup");
  const original = page.context.fetch;
  page.context.fetch = async (path, options) =>
    path === "/api/me"
      ? ({
          ok: false,
          status: 401,
          json: async () => ({ error: "LOGIN_REQUIRED" }),
        } as any)
      : original(path, options);
  await runInNewContext("refresh()", page.context);
  assert.equal(page.get("#login").hidden, false);
  assert.equal(page.get("#account").hidden, true);
  assert.equal(page.get("#agent").children.length, 0);
  assert.equal(page.polling(), undefined);
});

test("busy actions suppress double clicks and restore controls after failure", async () => {
  const page = await portal("ready");
  const button = page.get("#reauth");
  button.textContent = "Send a fresh sign-in link";
  let finish!: () => void;
  let calls = 0;
  page.context.fetch = async () => {
    calls++;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    throw Error("offline");
  };
  const event = { currentTarget: button, preventDefault() {} };
  const pending = button.onclick!(event);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Working…");
  assert.equal(button.attributes.get("aria-busy"), "true");
  await button.onclick!(event);
  assert.equal(calls, 1);
  finish();
  await pending;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Send a fresh sign-in link");
  assert.equal(button.attributes.has("aria-busy"), false);
  assert.match(page.get("#notice").textContent, /may have completed/);
});

test("non-JSON upstream failures have actionable copy without leaking server output", async () => {
  const page = await portal("ready");
  page.context.fetch = async () =>
    ({
      ok: false,
      status: 502,
      json: async () => {
        throw Error("private upstream detail");
      },
    }) as any;
  await page.get("#billing").onclick!();
  assert.match(page.get("#notice").textContent, /temporarily unavailable/);
  assert.doesNotMatch(
    page.get("#notice").textContent,
    /private|SyntaxError|SERVICE_UNAVAILABLE/,
  );
});

test("account details never carry over to a different tenant", async () => {
  const page = await portal("awaiting_setup");
  page.get("#agent").querySelectorAll("input")[0].value = "age1-other-tenant";
  page.customer.tenants[0].id = "another-tenant";
  await runInNewContext("refresh()", page.context);
  assert.equal(page.get("#agent").querySelectorAll("input")[0].value, "");
});

test("a malformed success response never reports the action as successful", async () => {
  const page = await portal("ready");
  page.context.fetch = async () =>
    ({
      ok: true,
      json: async () => {
        throw Error("invalid JSON");
      },
    }) as any;
  await page.get("#reauth").onclick!();
  assert.match(page.get("#notice").textContent, /temporarily unavailable/);
  assert.doesNotMatch(page.get("#notice").textContent, /Check your email/);
});

test("malformed account data preserves the last good view and keeps retrying", async () => {
  const page = await portal("awaiting_setup");
  const section = page.get("#agent").children[0];
  const original = page.context.fetch;
  page.context.fetch = async (path, options) =>
    path === "/api/me"
      ? ({ ok: true, json: async () => ({}) } as any)
      : original(path, options);
  await runInNewContext("refresh()", page.context);
  assert.equal(page.get("#agent").children[0], section);
  assert.equal(page.get("#login").hidden, true);
  assert.ok(page.polling());
  page.context.fetch = original;
  await page.polling()!();
  assert.equal(page.get("#connection").textContent, "");
});
