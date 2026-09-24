import { cleanup } from "./control.js";
try {
  await cleanup();
  console.log("Journey cleanup verified.");
} catch {
  console.error(
    "Journey cleanup incomplete. Inspect the sanitized cleanup report and retained private state.",
  );
  process.exitCode = 1;
}
