# Operations and failure recovery

## Deployment

Start with `npm ci && npm run upcloud:inspect` to check the account without creating resources. It reads `UPCLOUD_TOKEN` from the environment/ignored `.env`, or from `~/.config/upcloud-agent/credentials.env`. The latter file should contain `UPCLOUD_TOKEN=...` and be readable only by you (`chmod 600`). Create the token under UpCloud Account → API Tokens; the automation does not need permission to create more tokens. Never paste tokens into chat, logs, or commits.

The inspection command only calls the account, plan, template, zone and pricing APIs. It reports current credits and any promotional-credit expiry breakdown returned by the API, Finnish-zone pricing, 2-core/4GB plans, and public Ubuntu 24.04 cloud-init templates. If expiry is absent, verify it in the account; a positive balance alone does not establish expiry. Choose the actual plan/template from this output before deploying. UpCloud access alone does not complete the product setup: the full test also needs the control VM, portal/tenant DNS with Cloudflare access, a publicly pullable pinned tenant image, SMTP, Stripe test configuration, and backup storage.

Cloud-init templates require `metadata=yes`. Server creation also enables the UpCloud firewall, as trial accounts reject requests that disable it. The host firewall blocks tenant containers from accessing metadata and private address ranges before workloads start. Explicit API rejections clear the create attempt for retry; network errors and server-side failures retain the reconciliation guard to prevent duplicate VMs. Provider errors expose only a sanitized error code, never the full response or bootstrap inputs.

Use a separate Finnish UpCloud VM for control services. Set a domain and DNS A record for the portal. Restrict its SSH, keep PostgreSQL unpublished, enable host firewall rules for 80/443, and retain operator access only through an administrative network. Docker Compose supplies local PostgreSQL, API, worker, migration job, and Caddy.

Run `node scripts/init-secrets.mjs` once. Edit ignored `.env`; never paste keys into issues or commits. Generate the backup age identity offline with `age-keygen`; put only its public recipient in `.env`. Store private identity, database backups, and the encryption key separately. Losing those keys prevents recovery.

Use distinct test/live stacks. Configure the actual UpCloud 2-core/4GB Starter plan ID and Ubuntu 24.04 template UUID using the read-only provider API. The default zone is pinned to fi-hel1. No cross-country fallback is performed.

Publish the tenant runtime with the GitHub workflow. Make the package pullable by the VM and set `TENANT_IMAGE` to the emitted immutable tag plus digest. The official OpenClaw browser image is already pinned in `.env.example`. Neither image uses a floating latest tag on tenants.

Configure a private, non-versioned S3 bucket in Finland. The backup service streams encrypted tenant archives to that bucket, keeps seven daily objects, and removes the tenant prefix after retention. Non-versioning is required so deletion removes historical content rather than leaving old versions. Enable provider-side encryption as defense in depth. Cloud-account and S3 credentials remain exclusively on the control service.

Set Stripe test keys and both price IDs, SMTP delivery, DNS credentials scoped to the agent zone, and the managed model API key. `node --env-file=.env --import tsx scripts/preflight.ts` performs read-only checks. Set `CHECKOUT_ENABLED=true` in the test stack to exercise paid test provisioning. This creates billable UpCloud resources even though the Stripe card is a test card.

Run `docker compose up --build -d`. Migrations run before the API and worker. Mount `models.json` and `release-evidence.json`; keep model `verified=false` until its real API/agent tests pass. The configured published model prices must be checked against the provider immediately before activation. Add a Verda entry only after endpoint, EU/Finland location, API behavior, rates, and tool calling are verified. No autonomous provider failover exists.

## Access and privacy

Email sign-in links are hashed, expire in 15 minutes, and are consumed only after a browser confirmation. Account sessions last seven days. The portal offers a fresh sign-in link without signing out; email links preserve the selected inference mode. Secret export, SSH changes, and cancellation require a login less than ten minutes old. Tenant access tickets expire in 60 seconds and are single-use; tenant sessions last one hour.

The browser terminal exposes only the upstream wizard, not an unauthenticated root shell. The authenticated tenant management service has access to that tenant's Docker socket to perform maintenance; it is part of the trusted computing base. It does not have the UpCloud account token. Owner-authorized SSH keys grant root privileges to the owner's isolated VM from the explicit IPv4 address supplied with the key. The address is persisted as a /32 firewall rule.

The pinned browser image requires an explicit bundled Chromium path on some architectures. Bootstrap discovers that path, enables headless mode, and disables Chromium’s internal setuid sandbox because the unprivileged container disallows privilege escalation. The dedicated VM and container are the browser isolation boundary. This tradeoff must be included in the deployment review.

The provider wizard can change settings. Its wrapper restores required Gateway authentication and allowed-origin settings after successful completion. Do not enable dangerous device-auth bypass settings. Device approval requires an exact request ID/public-key match created during the current owner session; a local WebSocket bridge binds the public key in the standard OpenClaw connection handshake to that authenticated session. Conversation frames are forwarded without persistence. The Gateway itself verifies the device signature before creating the pending request. Do not auto-approve every pending device.

Platform access logs never store URLs containing access tickets, provider keys, prompts, or responses. JWT/login tokens travel in URL fragments, then POST bodies. OpenClaw intentionally stores the customer's own conversations on their VM. BYOK prompts travel directly to the customer's chosen provider. Managed-credit prompts transit the inference gateway and the disclosed EU provider without body logging. Infrastructure administrators can access tenant systems; this is not zero-knowledge hosting.

## Failure recovery and monitoring

Inspect the `incidents` table and `jobs.error_code`; alert on newly unresolved incidents with an infrastructure monitor. `/healthz` verifies API/database availability. Worker monitoring detects low disk, missing backups, unreachable tenants, missing token usage, and repeated jobs. `scripts/status.ts` emits a content-free operations summary; it exits nonzero on unresolved incidents or stale worker progress. Configure your external monitor against this command before launch.

Jobs are durable, leased, retried with backoff, and eventually require operator attention. A provider create request is marked before dispatch. After a timeout, lookup by stable hostname can adopt an existing server; no second create request is sent blindly. If reconciliation still finds no server, inspect the UpCloud account and audit trail. Only after proving the original operation did not create a VM may an operator reset the attempt and requeue it with `scripts/retry-provision.ts`. Never reset merely because the original HTTP response was lost.

Repeated provisioning failure preserves the paid order and raises an incident. Resolve provisioning or issue an appropriate Stripe refund/cancellation; this implementation does not invent a refund policy or silently delete paid orders. The service must not launch without an operator responding to these alerts.

The credit gateway reserves the full configured context ceiling plus capped output before dispatch. This deliberately over-reserves briefly to prevent undercounting prompt/tool tokens. Actual usage releases the difference. A disconnected browser does not cancel usage collection. Partial generations are never retried automatically. Missing/invalid usage is quarantined; after 24 hours the reservation is released with no customer charge and an operator incident. Reconcile provider invoices independently; the operator absorbs unresolved usage. Refunds and chargebacks reverse credit cumulatively, block new requests where debt remains, and never silently create negative wallet balances.

Daily tenant backups pause the Gateway briefly. Subscription cancellation ends at the paid period boundary. A failed renewal has a seven-day grace period. Suspension shares the host operation lock with exports/backups so archive cleanup cannot restart an already suspended workload. Existing access sessions are rejected while export sessions remain usable. Suspension stops OpenClaw but leaves the access service available for export; the VM/storage continue costing money during the 30-day retention period. Deletion removes the VM, recorded disks, DNS record, and backup objects. Subscription recovery before deletion resumes the existing agent. A control-plane outage must be repaired promptly because lifecycle and backup jobs run there.

## Updates and rollback

Run `scripts/tenant-update.sh PINNED_OFFICIAL_IMAGE` as root on a canary tenant. It pre-pulls the image, takes a quiesced local state snapshot, updates the pin, checks health, and restores the prior image and state on failure. Validate real provider and messaging behavior before applying the same pin to other tenants. Keep or securely remove the pre-upgrade snapshot after the rollback window; it contains credentials. Updating the deployment default affects new tenants only.

Back up PostgreSQL daily using `scripts/control-backup.sh`, with the same Finland-only encrypted object-storage policy. Save signing/encryption keys separately. Test restoring database and keys together before live launch. PostgreSQL holds billing identifiers and ledger metadata, not agent conversations. Stripe remains an external payment processor and SMTP sees login email addresses; do not market billing/email metadata as exclusively local.

## Security release review

Read [the production security review](SECURITY-AUDIT-2026-09-24.md) before enabling live payments. Keep `productionSecurity` false until the reviewed image and final infrastructure pass the listed deployment checks. Repository tests alone do not establish that.

Security updates change both account and tenant sessions to Secure `__Host-` cookies. Existing sessions require a fresh sign-in/handoff after rollout. Local browser development must use HTTPS or localhost. Opening the Stripe billing portal now requires authentication within the last ten minutes.

New tenant bootstrap enables ttyd origin checking and tenant HSTS/framing headers. Updating only the runtime image does not change an existing VM's generated terminal unit or Caddyfile; update those files explicitly, validate Caddy and reload services, then verify that same-origin terminal access works and foreign-origin WebSockets are rejected. Do not rerun the whole bootstrap on an existing tenant: it initializes state/configuration.
