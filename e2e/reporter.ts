import { mkdir, copyFile, writeFile } from "node:fs/promises";
import type {
  Reporter,
  TestCase,
  TestResult,
  FullResult,
} from "@playwright/test/reporter";
// Default Playwright HTML/trace output can include API keys, cookies and magic links.
// Export only named, explicitly redacted evidence and test-level outcomes.
const output = process.env.JOURNEY_REPORT_DIR ?? "journey-report";
export default class SafeReporter implements Reporter {
  private results: unknown[] = [];
  private copies: Promise<unknown>[] = [];
  onTestEnd(test: TestCase, result: TestResult) {
    this.results.push({
      test: test.titlePath().slice(1).join(" / "),
      status: result.status,
      durationMs: result.duration,
      errors: result.errors.map((error) => {
        const message = (error.message ?? "").replace(/^Error: /, "");
        const location = error.stack?.match(
          /(?:customer\.spec|openclaw|payments)\.ts:\d+:\d+/,
        )?.[0];
        return {
          code: /^[A-Z][A-Z0-9_]{0,100}$/.test(message)
            ? message
            : "ASSERTION_OR_BROWSER_FAILURE",
          location,
        };
      }),
    });
    console.log(`${result.status}: ${test.title}`);
    for (const [index, a] of result.attachments.entries()) {
      if (!["application/json", "image/png"].includes(a.contentType)) continue;
      const extension = a.contentType === "image/png" ? "png" : "json";
      const name = `${test.id.replace(/[^a-z0-9]/gi, "_")}-${index}-${a.name.replace(/[^a-z0-9-]/gi, "_")}.${extension}`;
      this.copies.push(
        (async () => {
          await mkdir(output, { recursive: true });
          if (a.body) await writeFile(`${output}/${name}`, a.body);
          else if (a.path) await copyFile(a.path, `${output}/${name}`);
        })(),
      );
    }
  }
  async onEnd(result: FullResult) {
    await Promise.all(this.copies);
    await mkdir(output, { recursive: true });
    await writeFile(
      `${output}/results.json`,
      JSON.stringify({ status: result.status, tests: this.results }, null, 2),
    );
  }
}
