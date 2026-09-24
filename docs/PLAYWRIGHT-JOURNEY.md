# Playwright customer journey runner

## Current acceptance status

The automated clean-journey runner is implemented but **has not been executed in a browser**. It is not evidence that signup, payment, onboarding, model chat or browser tools work. The Codex browser policy verification failure is still unresolved. No replacement browser was launched and no live workflow was dispatched while preparing this suite.

Use the suite only in an environment where the browser testing is actually authorized. A workflow input or environment variable is an audit record, not an override of an administrative denial. Live execution is disabled by default (`JOURNEY_LIVE_ENABLED` is unset). Set it only after policy authorization, inbox setup and the budget/adapter checks below have been resolved. The live workflow requires a protected `customer-journey` GitHub environment with a required reviewer and verifies that protection read-only. Do not remove this check to get a run through.

Normal push/PR checks only typecheck and enumerate the Playwright suite and run the browser-free harness unit tests. They do not install/launch browsers, provision cloud resources, send mail, call paid models, or use journey secrets.

## What the runner does

`npm run journey:test` runs BYOK and then managed credits. Each gets its own control server, fresh PostgreSQL database, unique provider hostname suffix, Stripe test prices and signed webhook. Only one control server and one tenant are intended to exist at once. A failed BYOK run prevents managed credits from being enabled. Successful BYOK streaming and browser-tool evidence qualifies only the separate test catalog; production models and release evidence are unchanged.

The browser starts on the landing page, selects the mode, requests signup, reads the delivered message through Gmail's read-only API, follows its link, completes Stripe test Checkout, and waits for the normal background worker. SQL is read-only throughout the clean journey. There are no seeded entitlements, direct provisioning calls, or tenant SSH/configuration repairs.

The browser then uses the standard ttyd wizard, the setup page's Copy Gateway token action, the dashboard connection form and session-bound pairing. It sends three synthetic prompts: remember a random code, recall it, and use the browser tool to read a separate random marker. The marker is never included in the prompt. Success requires streamed gateway events, an assistant reply containing the remembered code, a browser-tool result containing the marker, and persisted messages after reload.

The wizard adapter targets OpenClaw `2026.9.6-browser` and fails on unknown prompts/options. Its terminal observer parses the output received by the real browser; it does not inject commands or invoke a noninteractive wizard. Dashboard and Stripe selectors are **unvalidated against the live rendered pages** and may require adjustment after the first authorized run. A failure must be fixed and the affected journey restarted cleanly.

## One-time environment setup

Create and protect the GitHub environment `customer-journey`, require reviewer approval, and configure these environment secrets:

| Secret | Purpose |
| --- | --- |
| `UPCLOUD_TOKEN` | Temporary Helsinki control/tenant infrastructure |
| `STRIPE_SECRET_KEY` | Test key only; live keys are rejected |
| `RESEND_SMTP_PASSWORD` | Resend API key used for TLS SMTP |
| `OPENAI_API_KEY` | Supplied test model key |
| `TEST_ACCOUNT_EMAIL` | The same inbox registered with Resend |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | OAuth access to that receiving inbox using `https://www.googleapis.com/auth/gmail.readonly` |

Set environment variable `UPCLOUD_TEMPLATE` to the verified public Ubuntu 24.04 cloud-init template UUID. The runner verifies the actual template and both server plans with UpCloud before creation. The live workflow inputs take an immutable runtime image tag **and** digest, plus the reference to the policy owner's approval of this browser testing environment.

The Resend key cannot retrieve Gmail messages. Gmail authorization is not configured by this change. The inbox reader verifies the authenticated Gmail account, matches recipient, subject, request time, mode and exact fresh hostname, and never marks messages read or deletes them. It does not substitute a database token or sender-side email record for delivered mail. See [Gmail message listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list).

Do not paste keys into workflow inputs, commits, screenshots or reports. Existing local credentials have **not** been copied into GitHub secrets or sent to another agent/service.

## Verification and execution

Browser-free checks:

```sh
npm ci
npm run journey:check
node --import tsx --test tests/journey-harness.test.ts
```

After the policy issue is resolved or a genuinely approved testing environment is established, dispatch `Customer journey (approved live test)` from the reviewed branch. Playwright and Chromium installation follow [Playwright's CI guidance](https://playwright.dev/docs/ci). Hosted Checkout uses only Stripe's documented test card, never a real payment method. The suite fails on unexpected payment UI rather than seeding a paid invoice. See [Stripe testing](https://docs.stripe.com/testing).

The workflow runs the runner, then attempts cleanup again in an `always()` step. If the runner is killed outside GitHub's normal cleanup window, rerun cleanup with the retained **private** state directory:

```sh
JOURNEY_STATE_DIR=data/journey-run/byok JOURNEY_REPORT_DIR=journey-report/byok npm run journey:cleanup
JOURNEY_STATE_DIR=data/journey-run/credits JOURNEY_REPORT_DIR=journey-report/credits npm run journey:cleanup
```

Local state is intentionally retained. A subsequent local run refuses to overwrite it. Verify cleanup and archive the private state before another run; GitHub-hosted jobs use fresh workspaces. A lost hosted runner can also lose its local journal: cloud/Stripe resources carry the run identifier for operator reconciliation. Cleanup is best-effort under process/runner loss, not a guarantee against external outages.

## Evidence and budget boundaries

Only allowlisted evidence goes into `journey-report/`: run/model/image identity, payment and webhook references, provider disk encryption, timings, redacted portal screenshot, gateway streaming/tool counters, original-rate settlement evidence and cleanup inventory. The custom reporter emits stable error codes or safe source locations, never raw Playwright error messages, request headers or response bodies. Traces, video and automatic failure screenshots are disabled because they can capture magic links, API keys, cookies and gateway tokens. Private configuration, SSH keys and journals remain under ignored `data/` and are not uploaded.

The cloud watchdog reserves EUR 2 for cleanup, uses the remaining EUR 9.98 ceiling after the first EUR 0.01786 attempt, checks balance every 30 seconds and stops new work after 40 minutes. Price/credit-unit interpretation is based on this account's verified EUR billing (100 raw credit units per euro); deployment fails if currency, price range, template or usable-credit expiry differs. Cleanup compares against an initially empty inventory and only deletes servers with this run's hostname and test ownership label, plus recorded disks. Stripe cleanup errors do not prevent attempting cloud cleanup.

The selected model is `gpt-4.1-mini-2025-04-14`. Managed requests have 2,048-token output and 32,768-token context limits in the separate catalog; the clean journey sends only three small prompts per mode. **This implementation does not establish a provider-enforced USD 5 hard cutoff for direct BYOK calls.** Before any live run, validate the wizard's selected snapshot and request/agent-turn limits and the test project's available spend controls. Do not present the cloud watchdog as an OpenAI budget guarantee. No OpenAI calls were made while preparing this suite.

## Coverage boundary

| Scenario | Automation supplied here | Live result |
| --- | --- | --- |
| Delivered signup, mode preservation, single-use link, host cookies | Clean browser suite | Unrun |
| Test Checkout, paid invoice, signed webhook processed by worker, exactly one encrypted tenant | Clean browser suite plus read-only provider/DB evidence | Unrun |
| Provisioning refresh, terminal wizard, dashboard connection and pairing | Clean browser suite | Unrun |
| Streaming, contextual follow-up, browser marker and reload persistence | Clean browser suite | Unrun |
| Managed top-up and one settlement at the original rate snapshot | Clean browser suite | Unrun |
| Foreign-origin mutation and unauthorized management rejection | Read-only/negative checks after clean chat | Unrun |
| Expired links, stale billing authentication, foreign-origin WebSocket rejection | Existing regression coverage; additional live scenarios still required | Pending |
| Canceled/declined Checkout and duplicate webhooks | Existing backend regression coverage; separate live scenarios still required | Pending |
| Insufficient credit, missing/invalid usage, top-up while held and evidence-backed reconciliation | Existing backend regression coverage; separate live fault fixtures still required | Pending |
| Stop/retention-plan/recovery and suspended export/SSH controls | Existing lifecycle regression coverage; separate live scenario still required | Pending |
| Journal link/navigation smoke | Existing content tests; live browser smoke still required | Pending |

Even if both clean browser tests pass, the aggregate report says `clean_journeys_passed_regressions_pending`. It never marks the whole original plan or production release gates passed. Custom domains, unrestricted email, messaging, scheduled backup recovery and real-money payments remain outside this run.
