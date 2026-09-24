# Validation record

Implementation date: 2026-09-24.

## Verified locally

- TypeScript typecheck and production compilation.
- 28 automated tests against PostgreSQL 17: concurrent reservations, exactly-once credit/settlement, refund debt, usage quarantine, signed webhooks, event deduplication, paid-invoice entitlement, account isolation, CSRF, fresh authentication, login and handoff replay prevention, worker lease recovery, suspension/deletion retention, ambiguous VM creation, and inference/tool-call forwarding with a mocked upstream.
- Generated cloud-init application files: shell syntax, Compose YAML parsing, loopback-only Gateway publication, and no Docker socket mounted in the OpenClaw container.
- JavaScript syntax for both customer portals.
- Official OpenClaw browser image `2026.9.6-browser` resolved to registry digest `sha256:62832668e3e5e139f745f7d3df892c9251eb53318b7d14a76c410dde1f25d730`.

## Not yet acceptance evidence

No live UpCloud VM, DNS record, Stripe product, Stripe charge, email delivery, paid inference request, or messaging-channel connection has been created or verified. No customer data was used. Local test keys and fake provider responses are not live acceptance evidence.

The packaged runtime and pinned OpenClaw image are being checked locally; record their results here before claiming those checks passed. `release-evidence.json` remains entirely unset. `models.json` deliberately has `verified: false`.

Public launch requires the real test-mode payment → VM → browser onboarding sequence, provider tool calls and streaming usage, Telegram/WhatsApp setup, an independent encrypted export/restore, backup/lifecycle recovery, network isolation, and a paid pilot. Deployment credentials, the domain, and service configuration have not been supplied in this task.
