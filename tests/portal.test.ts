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
  onclick?: () => Promise<void>;
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
