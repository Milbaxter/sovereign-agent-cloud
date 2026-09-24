# Customer journey attempt — 24 September 2026

**Result: blocked before browser signup; neither customer journey passed.** Credentials are configured. The blocker is browser tooling, not a demonstrated application failure.

## Build and deployment

- Reviewed base: `39983d4e9ea02fadfef97436e137c6b94c72e9a9`.
- Tested implementation: `91821cdcd0bab8e337bb77f2c867ca9e31fe0b81`.
- Control/tenant runtime: `ghcr.io/milbaxter/sovereign-agent-cloud:sha-91821cdcd0bab8e337bb77f2c867ca9e31fe0b81@sha256:a6e3653205f6b260e3153e888f7608b0fbdef1ffb60db61abaf8dabe453a3d6c`.
- Configured OpenClaw image, **not started during this attempt**: `ghcr.io/openclaw/openclaw:2026.9.6-browser@sha256:62832668e3e5e139f745f7d3df892c9251eb53318b7d14a76c410dde1f25d730`.
- [Implementation CI](https://github.com/Milbaxter/sovereign-agent-cloud/actions/runs/35992291472): 84 tests, typechecking, formatting, build, dependency audit, Docker build and packaged runtime checks passed before deployment.
- [Runtime publication](https://github.com/Milbaxter/sovereign-agent-cloud/actions/runs/35992373956) completed; anonymous image pull worked.

The temporary `fi-hel1` control server used `STARTER-2xCPU-4GB`. Provider UUID: `009f4eaf-6a41-4b71-82ac-561ff4e80174`. At 11:35:27 UTC its provider details reported `started` and affirmative `storage_encrypted: yes` for its disk. This proves control-disk encryption only; no tenant was provisioned.

At approximately 11:34 UTC, API, worker and Caddy containers were running, PostgreSQL was healthy, and `001_initial.sql`, `002_operations.sql`, `003_cost_guards.sql` and `004_bootstrap_readiness.sql` were recorded as applied. The fresh database contained zero tenants. The application runtime digest matched the published pin.

The temporary control hostname returned HTTP/2 200 for `/healthz` with normal TLS certificate validation, HSTS and `X-Robots-Tag: noindex,nofollow`. The hostname has been retired and must not be reused without a new allocation.

## Verified prerequisites

| Check | Result | Evidence/limit |
| --- | --- | --- |
| BYOK preflight | Pass | All 12 checks passed, including plan, template, retention plan, pinned images and required configuration. Scheduled S3 checks explicitly deferred. |
| Stripe test authentication/configuration | Pass | Test API accepted hosting EUR 25/month and EUR 10 credit prices. No Checkout session, invoice or payment was created. |
| Resend SMTP authentication | Pass | TLS SMTP verification succeeded; inbox setting is present. No signup message was sent, so delivery remains unverified. |
| OpenAI model access | Pass | `gpt-4.1-mini-2025-04-14` returned HTTP 200 and `qualification-ok` at 11:30:18 UTC. Usage: 13 input, 2 output tokens. This was a direct, non-streaming qualification request. |
| Public control HTTPS and migrations | Pass | HTTP 200, validated TLS, noindex header, four applied migrations and healthy fresh database. |
| Customer browser access | Blocked | Codex denied the initial landing-page navigation because its browser security policy check was unavailable. |

## Browser blocker and untested acceptance

The browser tool reported: “The admin-enforced policy could not be verified, so access was not granted.” It explicitly prohibited bypasses or indirect workarounds. No alternate browser or scripted customer flow was used to circumvent that denial. No browser screenshots were obtained.

The following remain **unverified**, despite existing automated regression coverage: delivered signup email; selected-mode preservation; expired/single-use links; hosted Checkout; invoice/webhook-driven provisioning; tenant encryption and HTTPS; provisioning refresh recovery; wizard, terminal and browser pairing; streamed and contextual model responses; browser-tool marker retrieval; conversation persistence; live cookie/origin/management security checks; declined/canceled checkout; duplicate webhook handling; managed-credit settlement and review reconciliation; suspension/retention/recovery; journal and purchase navigation.

There was no clean customer journey and no fault injection. Managed credits stayed disabled, and the separate test model remained unverified in OpenClaw. Production catalogs and release acceptance gates were unchanged.

## Payment references, budget and cleanup

- Hosting test price: `price_1UJApdCr8oInGVYkqKZDtAk2`.
- Credit test price: `price_1UJApdCr8oInGVYkJIoBoON6`.
- Webhook: `we_1UJApeCr8oInGVYkl0WMONyc` — confirmed disabled at 11:35:29 UTC. Both test prices and products were archived.
- No subscriptions used the run's hosting price; nothing required cancellation. No invoice or payment references exist.
- Initial inventory at 11:26:54 UTC: zero servers, private disks and allocated IPs. Cleanup at 11:36:10 UTC confirmed the same empty inventory after deleting the control server and its disk.
- Provider monthly billing reported EUR **0.01786** for this control VM, billed for one hour. The raw account-credit decrease was 1.7857; use the currency-denominated billing result, not that raw number as euros. [UpCloud billing API](https://developers.upcloud.com/api/1.3/account) provides resource-specific amounts.
- OpenAI usage was 15 tokens total for the qualification request, far below the USD 5 limit. No tenant model calls occurred. Cloud consumption was below the EUR 10 limit; no resources remain accruing charges.

Private raw evidence and configuration are stored in ignored `data/journey/` and credential files. This report excludes email addresses, API keys, signing keys, webhook secrets and authentication tokens.

## Resume requirements

Resolve the Codex browser-policy verification failure before spending on another deployment. Then recheck the budget and inventory, use a new run identifier and fresh control/tenant allocation, configure a fresh webhook and active test prices, and rerun BYOK from the landing page. Only successful OpenClaw streaming/tool qualification permits enabling the managed-credit journey in its separate fresh database. Preserve the remaining regression and cleanup requirements in [the run plan](CUSTOMER-JOURNEY.md).
