import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

async function setupPage() {
  const nodes = new Map<string, any>();
  const get = (selector: string): any => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        hidden: false,
        disabled: false,
        textContent: "",
        value: "",
        tagName: selector === "#pair" ? "FORM" : "BUTTON",
        attributes: new Map(),
        setAttribute(name: string, value: string) {
          this.attributes.set(name, value);
        },
        removeAttribute(name: string) {
          this.attributes.delete(name);
        },
        querySelector() {
          return get("#pair button");
        },
      });
    return nodes.get(selector);
  };
  let pending: any[] = [];
  let clipboardFailure = false;
  const calls: { path: string; body: any }[] = [];
  const context = {
    document: { querySelector: get },
    URLSearchParams,
    AbortSignal,
    FormData: class {
      *[Symbol.iterator]() {
        yield ["requestId", get('#pair input[name="requestId"]').value];
        yield ["publicKey", get('#pair input[name="publicKey"]').value];
      }
    },
    location: { hash: "", pathname: "/setup" },
    navigator: {
      clipboard: {
        writeText: async () => {
          if (clipboardFailure) throw Error("denied");
        },
      },
    },
    fetch: async (path: string, options: any) => {
      calls.push({
        path,
        body: options.body ? JSON.parse(options.body) : undefined,
      });
      return {
        ok: true,
        json: async () =>
          path === "/api/local/info"
            ? {
                action: "access",
                gatewayToken: "private-key",
                controlOrigin: "https://account.test",
                mode: "byok",
              }
            : path === "/api/local/devices"
              ? { pending }
              : { ok: true },
      };
    },
  };
  await runInNewContext(
    await readFile("tenant-public/app.js", "utf8"),
    context,
  );
  return {
    get,
    context,
    calls,
    devices(value: any[]) {
      pending = value;
    },
    blockClipboard() {
      clipboardFailure = true;
    },
  };
}

test("pairing guides an empty result without exposing raw JSON", async () => {
  const page = await setupPage();
  await page.get("#devices").onclick();
  assert.equal(page.get("#pair").hidden, true);
  assert.match(page.get("#pending").textContent, /No waiting connection/);
  assert.equal(page.get("#account-link").href, "https://account.test");
});

test("only a single matching device reveals approval and success clears the form", async () => {
  const page = await setupPage();
  page.devices([{ requestId: "request", publicKey: "device-public-key" }]);
  await page.get("#devices").onclick();
  assert.equal(page.get("#pair").hidden, false);
  assert.doesNotMatch(
    page.get("#pending").textContent,
    /device-public-key|requestId/,
  );
  await page.get("#pair").onsubmit();
  assert.deepEqual(page.calls.at(-1), {
    path: "/api/local/pair",
    body: { requestId: "request", publicKey: "device-public-key" },
  });
  assert.equal(page.get("#pair").hidden, true);
  assert.match(page.get("#pending").textContent, /Browser approved/);
});

test("a failed device refresh clears stale approval details", async () => {
  const page = await setupPage();
  page.devices([{ requestId: "stale", publicKey: "stale-key" }]);
  await page.get("#devices").onclick();
  page.context.fetch = async () => {
    throw Error("offline");
  };
  await page.get("#devices").onclick();
  assert.equal(page.get("#pair").hidden, true);
  assert.equal(page.get('#pair input[name="requestId"]').value, "");
  assert.match(page.get("#notice").textContent, /Connection interrupted/);
});

test("multiple pending requests never auto-select a device", async () => {
  const page = await setupPage();
  page.devices([{ requestId: "one" }, { requestId: "two" }]);
  await page.get("#devices").onclick();
  assert.equal(page.get("#pair").hidden, true);
  assert.match(page.get("#pending").textContent, /Close duplicate/);
});

test("blocked clipboard gives recovery guidance without printing the connection key", async () => {
  const page = await setupPage();
  page.blockClipboard();
  await page.get("#copy").onclick();
  assert.match(page.get("#notice").textContent, /Allow clipboard access/);
  assert.doesNotMatch(page.get("#notice").textContent, /private-key/);
});

test("tenant actions suppress duplicate submissions and restore failed controls", async () => {
  const page = await setupPage();
  let finish!: () => void;
  let requests = 0;
  page.context.fetch = async () => {
    requests++;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    throw Error("offline");
  };
  const button = page.get("#devices");
  button.textContent = "Find this browser";
  const event = { currentTarget: button, preventDefault() {} };
  const running = button.onclick(event);
  assert.equal(button.disabled, true);
  await button.onclick(event);
  assert.equal(requests, 1);
  finish();
  await running;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Find this browser");
  assert.equal(button.attributes.has("aria-busy"), false);
});
