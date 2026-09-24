import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page, TestInfo } from "@playwright/test";

export async function evidence(info: TestInfo, name: string, value: unknown) {
  // Callers supply allowlisted summaries, never raw request/response payloads.
  await info.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json",
  });
}
export async function portalScreenshot(page: Page, info: TestInfo) {
  await info.attach("portal-redacted", {
    body: await page.screenshot({
      fullPage: true,
      mask: [
        page.locator("#email"),
        page.locator("input"),
        page.locator("#pending"),
      ],
    }),
    contentType: "image/png",
  });
}
export async function writePrivate(path: string, value: unknown) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}
