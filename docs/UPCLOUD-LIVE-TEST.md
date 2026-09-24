# UpCloud live infrastructure validation

Test date: 24 September 2026. No customer data or real payments were used.

## Scope and method

A dedicated control VM and tenant VM ran in UpCloud fi-hel1 on Ubuntu 24.04, using the Starter 2 CPU / 4 GB plan with its included 30 GB standard disk and public IPv4. The control VM ran PostgreSQL 17 and the actual application image. The tenant ran the pinned official OpenClaw browser image and the application access service. No local Docker services were started for this test.

The operator harness invoked the production `Provisioner` directly. It seeded a test account and a one-day entitlement instead of exercising Stripe checkout. A temporary DNS adapter used the assigned IPv4 address to choose a resolving sslip.io hostname before the single-use bootstrap bundle was consumed. The adapter updated the test tenant's hostname and provider hostname; it did not exercise Cloudflare. Both hosts obtained public HTTPS certificates.

This verifies the real provisioning and lifecycle path, not the complete purchase-to-conversation customer journey or background worker scheduling.

## Defects found and fixed

- UpCloud rejected cloud-init creation with metadata disabled. Creation now enables metadata; host firewall restrictions are installed before tenant workloads start.
- The trial account rejected disabling the UpCloud firewall. Creation now enables it.
- Explicit provider rejections left an unusable create attempt behind the duplicate-prevention guard. Rejected attempts now clear stale bootstrap and inference credentials for retry; ambiguous failures retain reconciliation protection.
- The rendered Caddy configuration used invalid inline blocks. Bootstrap now emits multiline blocks, and CI validates the rendered configuration with real Caddy.
- Provider error reporting now includes sanitized error codes without leaking response descriptions, credentials or bootstrap data. Malformed inventory responses fail closed.

## Live results

Eleven assertions passed against both the first real tenant and a fresh tenant created from the corrected image:

1. Provisioning reached `awaiting_setup`.
2. The official OpenClaw container was installed and running.
3. Unauthenticated management requests were rejected.
4. The control API consumed a login token and issued a session.
5. The tenant accepted a signed owner handoff.
6. Reusing that handoff was rejected.
7. The owner's session authorized access.
8. An encrypted backup was downloaded from the real tenant.
9. Suspension stopped OpenClaw and rejected the existing owner session.
10. Resume restarted OpenClaw.
11. Owner access worked again after resume.

The OpenClaw health command also passed. The first downloaded archive was decrypted with the separately held age identity and its checksums verified. This does not establish cross-cloud restore acceptance. The first tenant required a manual Caddy configuration repair during diagnosis. A fresh install with the corrected published image completed cloud-init at about 186 seconds of uptime, passed Caddy validation and all eleven assertions without any manual configuration repair, and reached `awaiting_setup` with its bootstrap token consumed.

The fixed implementation passed all 53 automated tests, formatting, typechecking, compilation, dependency audit, image build, tenant lifecycle smoke test, and rendered-bootstrap Caddy validation in [GitHub Actions](https://github.com/Milbaxter/sovereign-agent-cloud/actions/runs/35986676385). The published runtime was built from commit `e43f8544a5b8ea6d29e341fd548cd990fd87d3c5`.

## Cleanup

At the user's request, all test VMs and their disks were deleted, including the control VM, the initial diagnostic tenant and the clean-install tenant. An earlier abandoned test VM/disk and temporary floating IP were also removed. A final read-only UpCloud inventory at 10:44 UTC on 24 September 2026 returned no servers, private disks or allocated IP addresses. Temporary test endpoints are no longer available.

## Remaining acceptance work

- Stripe test checkout, invoicing and webhook-driven provisioning.
- SMTP sign-in delivery and production Cloudflare DNS automation.
- Visual browser onboarding and a real model conversation with streaming/tool calls.
- Messaging channels, scheduled S3 backup/restore, full isolation acceptance, and a paid pilot.

Browser automation was unavailable because the browser tool could not complete its admin-enforced security-policy check. No alternate browser route was used. Model verification flags and release acceptance gates remain unset.
