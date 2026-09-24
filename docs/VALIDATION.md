# Validation record

Implementation date: 2026-09-24.

## Verified locally

- TypeScript typecheck and production compilation.
- 44 automated tests against PostgreSQL 17: concurrent reservations, exactly-once credit/settlement, refund debt, usage quarantine, signed webhooks, event deduplication, paid-invoice entitlement, account isolation, CSRF, fresh authentication, login and handoff replay prevention, worker lease recovery, suspension/deletion retention, ambiguous VM creation, and inference/tool-call forwarding with a mocked upstream.
- Generated cloud-init application files: shell syntax, Compose YAML parsing, loopback-only Gateway publication, and no Docker socket mounted in the OpenClaw container.
- JavaScript syntax for both customer portals.
- Official OpenClaw browser image `2026.9.6-browser` resolved to registry digest `sha256:62832668e3e5e139f745f7d3df892c9251eb53318b7d14a76c410dde1f25d730`.

## Not yet acceptance evidence

Live UpCloud provisioning, public HTTPS, owner access, encrypted export and suspension/resumption were subsequently tested; see [the live infrastructure record](UPCLOUD-LIVE-TEST.md) for the method and limits. No Stripe product/charge, email delivery, paid inference request, production Cloudflare DNS record or messaging-channel connection was verified. No customer data was used. Local test keys and fake provider responses are not live acceptance evidence.

The packaged runtime builds successfully. The pinned official OpenClaw Gateway starts, accepts the managed-provider configuration, and reports healthy. Its bundled Chromium starts headlessly after explicit executable-path and container sandbox configuration. A synthetic state archive was age-encrypted, decrypted, checksum-verified, and started successfully in an independent restored container using `scripts/local-runtime-smoke.sh`. This is a local portability test, not a live cross-cloud migration. The first GitHub Actions run passed. Browser onboarding visual/end-to-end verification was blocked because the app browser tool could not verify the admin-enforced security policy; no alternate browser route was used to bypass it. `release-evidence.json` remains entirely unset. `models.json` deliberately has `verified: false`.

Public launch requires the real test-mode payment → VM → browser onboarding sequence, provider tool calls and streaming usage, Telegram/WhatsApp setup, an independent encrypted export/restore, backup/lifecycle recovery, network isolation, and a paid pilot. An UpCloud token was supplied privately for infrastructure testing. Production domain, payment, email, model and backup-storage configuration remain outstanding.

## Review fixes — 24 September 2026

The integrated backend and marketing branch now has 44 automated tests, including stable Stripe retry parameters, effective catalog release gating, retained founding-account capacity, bounded usage records, preserved email inference selection, fresh reauthentication, pending-payment polling, and suspension checks. Portal interaction tests use a DOM harness; they are not visual browser acceptance.

`scripts/tenant-lifecycle-smoke.sh` exercises the built access-service image with synthetic state, real HTTP/SQLite/flock/age, and a Docker command test double. It verifies authorization for more than 60 asset checks, rejected unauthenticated management calls, a concurrent backup followed by suspension, continued export-session access, and recovery. It has no host Docker socket, cloud connection, or customer data. The Docker build and this smoke test are now part of CI. The later [UpCloud test](UPCLOUD-LIVE-TEST.md) covers real OpenClaw suspension/resumption and owner access; the complete customer acceptance flow remains outstanding.

See [the review](REVIEW.md) for remaining launch requirements. No release-evidence field or model verification flag was changed by this review.
