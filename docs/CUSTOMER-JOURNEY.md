# Customer journey acceptance run

## Status

Base commit: `39983d4e9ea02fadfef97436e137c6b94c72e9a9` (merged main).

The customer journey is **not yet passed**. The code now supports a temporary HTTPS deployment through the real provisioning worker without a Cloudflare zone. Bootstrap cannot expose credentials until the worker has verified encrypted disks and prepared DNS. The test hostname is separate from immutable provider identity, which is also used by suspension and recovery.

Read-only UpCloud inspection on 24 September 2026 found no servers, private disks or allocated IPs. Helsinki Starter 2 CPU/4 GB and the stopped `CLOUDNATIVE-1xCPU-4GB` retention plan are available. Promotional credits expire at 2026-10-24 09:19:55 UTC; recheck before deployment. No resources have been created for this run.

## Configuration

Use a private ignored environment file. Required external credentials are `STRIPE_SECRET_KEY` (test), `OPENAI_API_KEY`, and `RESEND_API_KEY`; `TEST_ACCOUNT_EMAIL` is the existing Stripe account email and must also be the Resend account email when using `onboarding@resend.dev`. Never include their values in evidence. Configure Resend via `SMTP_URL` with TLS at `smtp.resend.com:465`, username `resend`, and the API key as password, percent-encoding credentials.

For the temporary deployment set:

- `BILLING_MODE=test`, `DNS_MODE=test_sslip`, `SEARCH_INDEXING_ENABLED=false`.
- `TEST_ACCOUNT_EMAIL` to the permitted inbox; other signup requests are rejected before SMTP or database access.
- `TENANT_DOMAIN=journey.invalid` as the immutable initial VM naming suffix. The worker assigns `a-<tenant UUID>.<public IPv4 with hyphens>.sslip.io` before bootstrap consumption. This mode never writes Cloudflare records.
- Real HTTPS `PUBLIC_ORIGIN` and `PORTAL_DOMAIN` for the control host; production-strength signing/encryption keys, encrypted control storage, pinned runtime images and restricted operator SSH access.
- `MAX_TENANTS=1`; enable checkout only after prerequisites pass.
- Stripe prices must be EUR 2500 recurring monthly for hosting and EUR 1000 non-recurring for credits, both tax-exclusive. Use test objects with a unique run identifier in metadata and signed delivery to `/webhooks/stripe`.
- Use a separate model catalog for `gpt-4.1-mini-2025-04-14` at `https://api.openai.com/v1`, keyed by `OPENAI_API_KEY`. First qualify the model through BYOK OpenClaw streaming and tool use. Enable managed credits only after recording that evidence. Test catalog rate snapshots must be explicit; they do not verify production provider pricing or data residency.

`npm run preflight -- --journey=byok` skips model qualification and explicitly defers scheduled S3 backup acceptance. `--journey=credits` also checks the managed model secret, listing and verification. Normal preflight retains the full production checks. A journey preflight may only be used with test billing; test DNS requires the inbox allowlist and indexing disabled.

Apply all migrations, including `004_bootstrap_readiness.sql`, before API and worker rollout. Existing provisioning attempts need the updated worker to release readiness. The updated cloud-init retries an explicit `BOOTSTRAP_NOT_READY` response without consuming the token. Already-running tenants are not re-bootstrapped or renamed. Use fresh tenants for this acceptance run.

## Run sequence and evidence

Use one control VM and one tenant VM at a time. Run BYOK first, save evidence and clean up that tenant/subscription, then use a separate fresh database for managed credits. Do not reset account state during a happy-path journey. Test-only fault fixtures are separate evidence.

| Check | Required evidence | Current result |
| --- | --- | --- |
| Signup and email | Delivered inbox message, selected mode retained, confirmed single-use link | Pending credentials/setup |
| Hosting checkout | Browser completion, paid invoice, signed event, durable worker job | Pending |
| Tenant provisioning | One VM, fresh provider encryption evidence, HTTPS, setup-ready portal | Pending |
| Browser onboarding | Wizard, gateway connection, session-bound pairing, no operator repair | Pending |
| Conversation | Streaming response, contextual follow-up, persisted conversation after reload | Pending |
| Browser tool | Actual tool execution reading a unique controlled-page marker | Pending |
| Managed credits | Checkout credit once, original-rate settlement once, insufficient balance recovery | Pending |
| Access recovery | Host cookies, fresh billing login, rejected foreign origins and management requests | Automated coverage; live pending |
| Usage uncertainty | Held reservation, top-up cannot unblock, evidence-backed idempotent reconciliation | Automated coverage; live pending |
| Suspension/recovery | Same VM stopped and parked, original plan restored, browser access recovered | Automated coverage; live pending |
| Public content | Journal links, purchase navigation and temporary-site noindex | Automated coverage; live pending |

Check expired/replayed login links, canceled/declined payments, duplicate webhooks and provisioning retries. Healthy paid provisioning must be driven by real Stripe test events, not seeded entitlements. Perform controlled expiry/usage fault injection only after saving the clean browser journey evidence. Label synthetic failures explicitly.

No cloud balance, successful SMTP API response, Stripe invoice event, container health result or mocked provider response substitutes for its corresponding customer acceptance check. Stripe test invoice events alone do not prove invoice-email delivery.

## Budget and cleanup

Limits agreed with the owner: EUR 10 total UpCloud resource consumption (including promotional credits) and USD 5 OpenAI usage. Reserve room for outstanding requests and resource cleanup; stop before a projected action would exceed either limit. Keep generated content synthetic and request/output limits small. Never rely on a provider budget notification as a hard spending cutoff.

Save redacted screenshots, timings, commit/image digests, webhook and invoice IDs, provider resource IDs and model/tool evidence. Do not record API keys, session cookies, magic-link fragments or gateway tokens.

Finally cancel only this run's test subscriptions, disable its webhook, delete its VMs/disks and release allocated IPs. Compare final inventory with the initial empty inventory. Custom-domain Cloudflare, unrestricted email recipients, scheduled backup recovery, messaging channels, real-money payments and production release gates remain outside this test's acceptance evidence.
