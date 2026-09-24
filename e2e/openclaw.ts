import { expect, type Page } from "@playwright/test";
import xterm from "@xterm/headless";
import { secret, type Manifest } from "./config.js";

export type Choice = {
  question: RegExp;
  option?: RegExp;
  text?: string;
  key?: string;
};
// Pinned classic wizard. Unknown prompts fail instead of guessing or opening a shell.
export function wizardChoices(mode: Manifest["mode"]): Choice[] {
  return [
    { question: /I understand this is personal-by-default/, option: /^Yes$/ },
    {
      question: /^Setup mode$/,
      option: mode === "byok" ? /^QuickStart/ : /^Keep existing model config/,
    },
    { question: /^Config handling$/, option: /^Keep current values/ },
    { question: /^What would you like to create\?$/, option: /^One agent/ },
    {
      question: /^What should we call your first agent\?$/,
      text: "Journey Agent",
    },
    {
      question: /^(Model\/auth provider|Choose an AI provider|Model provider)/,
      option: /^OpenAI(?:\s|$)/,
    },
    {
      question: /^(OpenAI auth method|Authentication method)/,
      option: /API key/,
    },
    {
      question: /^(Enter|Paste).*OpenAI.*API key|^OpenAI API key/,
      key: "OPENAI_API_KEY",
    },
    {
      question: /^How.*(?:provide|store).*API key/,
      option: /Paste.*(?:key|now)|Enter.*key/,
    },
    { question: /^Default model$/, option: /Enter model manually/ },
    {
      question: /^Default model \(.*|^Model ID|^Enter model/,
      text: "openai/gpt-4.1-mini-2025-04-14",
    },
    { question: /^Test AI access now/, option: /^Yes$/ },
    { question: /^Select channel|^Choose.*channel/, option: /Skip for now/ },
    { question: /^Configure.*channels.*\?$/, option: /^No$/ },
    { question: /^(Import|Bring).*memory.*\?$/, option: /^No$|Skip/ },
    { question: /^Search provider$/, option: /Skip for now|Do not configure/ },
    { question: /^Configure skills now/, option: /^No$/ },
    { question: /^Help make OpenClaw better\?$/, option: /No thanks/ },
    {
      question: /^How do you want to hatch your agent\?$/,
      option: /Hatch later/,
    },
  ];
}
export function currentPrompt(screen: string) {
  const lines = screen.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++)
    if (/^\s*[◆◇]\s/.test(lines[i])) start = i;
  if (start < 0 || !lines[start].includes("◆")) return;
  const question = lines[start].replace(/^\s*◆\s*/, "").trim();
  const options = lines.slice(start + 1).flatMap((line) => {
    const match = line.match(/[●○]\s+(.+?)(?:\s+\(.*\))?$/);
    return match
      ? [{ label: match[1].trim(), selected: line.includes("●") }]
      : [];
  });
  return { question, options };
}
export async function completeWizard(
  terminalPage: Page,
  setup: Page,
  m: Manifest,
) {
  const screen = new xterm.Terminal({
    cols: 120,
    rows: 40,
    allowProposedApi: true,
    scrollback: 2000,
  });
  let connected = false,
    pending = Promise.resolve();
  terminalPage.on("websocket", (ws) => {
    if (!new URL(ws.url()).pathname.startsWith("/terminal")) return;
    connected = true;
    ws.on("framesent", (frame) => {
      try {
        const raw = String(frame.payload),
          body = JSON.parse(raw.startsWith("1") ? raw.slice(1) : raw);
        if (body.columns && body.rows) screen.resize(body.columns, body.rows);
      } catch {}
    });
    ws.on("framereceived", (frame) => {
      const bytes = Buffer.isBuffer(frame.payload)
        ? frame.payload
        : Buffer.from(frame.payload);
      if (bytes[0] === 48)
        pending = pending.then(
          () =>
            new Promise<void>((done) => screen.write(bytes.subarray(1), done)),
        );
    });
  });
  await terminalPage.goto(new URL("/terminal/", setup.url()).href);
  await terminalPage.locator(".xterm-screen").click();
  const seen = new Set<string>(),
    deadline = Date.now() + 8 * 60000;
  let answered = 0;
  try {
    while (Date.now() < deadline) {
      await pending;
      const buffer = screen.buffer.active;
      const text = Array.from(
        { length: buffer.length },
        (_, i) => buffer.getLine(i)?.translateToString(true) ?? "",
      ).join("\n");
      if (
        /Onboarding complete, but|Provider setup failed|AI access test failed/.test(
          text,
        )
      )
        throw Error("OPENCLAW_WIZARD_FAILED");
      if (/Onboarding complete\./.test(text)) {
        if (!connected || answered < 2) throw Error("WIZARD_EVIDENCE_MISSING");
        return { terminalWebSocket: true, promptsAnswered: answered };
      }
      const prompt = currentPrompt(text);
      if (prompt && !seen.has(prompt.question)) {
        const choice = wizardChoices(m.mode).find((c) =>
          c.question.test(prompt.question),
        );
        if (!choice) throw Error("UNRECOGNIZED_WIZARD_PROMPT");
        if (choice.option) {
          const target = prompt.options.findIndex((o) =>
              choice.option!.test(o.label),
            ),
            current = prompt.options.findIndex((o) => o.selected);
          if (target < 0 || current < 0)
            throw Error("WIZARD_OPTION_NOT_VISIBLE");
          for (let i = 0; i < Math.abs(target - current); i++)
            await terminalPage.keyboard.press(
              target > current ? "ArrowDown" : "ArrowUp",
            );
        } else {
          await terminalPage.keyboard.press("Control+u");
          await terminalPage.keyboard.insertText(
            choice.key ? secret(choice.key) : choice.text!,
          );
        }
        await terminalPage.keyboard.press("Enter");
        seen.add(prompt.question);
        answered++;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw Error("WIZARD_TIMEOUT");
  } finally {
    screen.dispose();
    await terminalPage.close();
  }
}
export type StreamEvidence = {
  deltas: number;
  finals: number;
  browserStarts: number;
  browserResults: number;
  markerInBrowserResult: boolean;
  lastAssistantText: string;
};
export function observeGateway(page: Page, marker: string) {
  const result: StreamEvidence = {
    deltas: 0,
    finals: 0,
    browserStarts: 0,
    browserResults: 0,
    markerInBrowserResult: false,
    lastAssistantText: "",
  };
  page.on("websocket", (ws) =>
    ws.on("framereceived", (frame) => {
      try {
        const event = JSON.parse(String(frame.payload)),
          p = event.payload;
        if (event.type !== "event") return;
        if (event.event === "chat" && p?.state === "delta") result.deltas++;
        if (
          event.event === "chat" &&
          ["delta", "final"].includes(p?.state) &&
          p?.message?.role === "assistant"
        ) {
          const content = p.message.content;
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text ?? "")
                    .join("")
                : "";
          if (text) result.lastAssistantText = text;
        }
        if (event.event === "chat" && p?.state === "final") result.finals++;
        if (
          event.event === "agent" &&
          p?.stream === "tool" &&
          p.data?.name === "browser"
        ) {
          if (p.data.phase === "start") result.browserStarts++;
          if (p.data.phase === "result") {
            result.browserResults++;
            if (JSON.stringify(p.data).includes(marker))
              result.markerInBrowserResult = true;
          }
        }
      } catch {}
    }),
  );
  return result;
}
export async function connectDashboard(setup: Page, dashboard: Page) {
  await setup
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(setup.url()).origin,
    });
  await setup
    .getByRole("button", { name: "Copy Gateway token", exact: true })
    .click();
  const gatewayToken = await setup.evaluate(() =>
    navigator.clipboard.readText(),
  );
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(gatewayToken))
    throw Error("GATEWAY_TOKEN_MISSING");
  await dashboard.goto(new URL("/", setup.url()).href);
  // Locator alternatives cover the pinned login gate and connection settings surfaces.
  const field = dashboard
    .getByLabel("Gateway secret", { exact: true })
    .or(dashboard.locator('input[type="password"]'));
  await field.first().fill(gatewayToken);
  await dashboard
    .getByRole("button", { name: /^(Connect|Apply and reconnect)$/ })
    .first()
    .click();
  await expect(async () => {
    await setup
      .getByRole("button", { name: "Find this browser", exact: true })
      .click();
    expect(
      await setup.locator('input[name="requestId"]').inputValue(),
    ).not.toBe("");
  }).toPass({ timeout: 60000, intervals: [3000, 5000] });
  await setup
    .getByRole("button", { name: "Approve this browser", exact: true })
    .click();
  await expect(setup.locator("#notice")).toHaveText(
    "Device approved. Reconnect your OpenClaw dashboard.",
  );
  await dashboard.reload();
  await expect(
    dashboard
      .locator(
        ".agent-chat__composer-combobox > textarea, .new-session-page__message",
      )
      .first(),
  ).toBeVisible({ timeout: 90000 });
}
export async function sendChat(
  page: Page,
  prompt: string,
  stream: StreamEvidence,
) {
  const previous = stream.finals;
  const input = page
    .locator(
      ".agent-chat__composer-combobox > textarea, .new-session-page__message",
    )
    .filter({ visible: true })
    .first();
  await input.fill(prompt);
  await input.press("Enter");
  await expect
    .poll(() => stream.finals, { timeout: 180000 })
    .toBeGreaterThan(previous);
}
