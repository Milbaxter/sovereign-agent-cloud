# Privacy boundaries and supportable security claims

Reviewed 24 September 2026. This is an engineering and communications policy, not a completed customer privacy notice, contractual guarantee, or certification of this application. [Validation](VALIDATION.md) governs what has actually been exercised.

## What the architecture permits

| Boundary | Current behavior | Required disclosure or follow-up |
| --- | --- | --- |
| Customer isolation | One VM per owner/trusted group | Group members do not have separate private accounts; a VM is not dedicated physical hardware |
| Live state | OpenClaw reads tenant files; operator SSH and the management service have privileged access | Administrators can access live knowledge and credentials |
| Customer export | age encrypts complete state to a supplied public recipient | The matching private key decrypts the archive; encryption does not hide the source files from the live server |
| Operational backup | age encryption uses a separately held operator recovery identity | These are operator-recoverable backups, not customer-exclusive encryption |
| BYOK inference | Requests leave the tenant for the selected provider | Bringing an API key does not prevent that provider from receiving request content |
| Prepaid inference | Requests pass through our gateway and the selected provider | No body logging is the intended implementation, not inability to access plaintext during processing |
| Memory/search and tools | Upstream settings and enabled integrations determine destinations | Verify embeddings, background jobs, logs, and tool traffic; do not infer locality from where files are stored |
| Account and operations data | Billing, SMTP, control services, and infrastructure logs have separate roles | Do not imply every category is stored only in Finland or disappears when one memory is deleted |

## What UpCloud documents

- [Block storage encryption](https://upcloud.com/docs/products/block-storage/encryption-at-rest/): optional AES-256 encryption with UpCloud-managed keys. Encryption is selected on creation, inherited by derived storage/backups, and can be introduced through an encrypted clone. Verify actual disks; a provisioning intention is not evidence.
- [Managed Object Storage encryption](https://upcloud.com/docs/products/managed-object-storage/full-encryption/): automatic server-side AES-256 encryption with keys managed by UpCloud. It complements our age layer; it does not provide customer-exclusive key custody.
- [Account security](https://upcloud.com/docs/getting-started/accounts/account-security/) and [audit logs](https://upcloud.com/docs/getting-started/accounts/audit-logs/): MFA and infrastructure activity records. These are not application-level knowledge access logs. Infrastructure audit records have their own retention.
- [Security and privacy](https://upcloud.com/security-privacy/): selected datacenter commitments, documented access restrictions, and ISO 27001 certification. Those assurances cover the provider's stated scope, not certification of our service or the absence of all privileged access.
- [Shared responsibility](https://upcloud.com/docs/getting-started/shared-responsibility/): customers remain responsible for cloud-server security and maintenance. Here, we operate that application/server layer on behalf of our users.

No verified confidential-computing or customer-exclusive key-management deployment is part of the current service. Do not imply that Finnish hosting, encryption at rest, or a provider certification proves that nobody can access running data.

## Claims policy

| Claim | When it is supportable |
| --- | --- |
| “We are building knowledge you can inspect, edit, and take with you.” | Describes the [accepted direction](PERSONAL-KNOWLEDGE.md), with planned features clearly marked |
| “Encrypted export tooling is implemented and locally tested.” | Supported by the current validation record; distinguish synthetic restore from live migration |
| “Your stored knowledge is encrypted at rest.” | After verifying all relevant live storage, staging files, backups, control data, and operational procedures; disclose key custody |
| “Your agent's stored context is hosted in Finland.” | After verifying deployed runtime and backup locations; disclose inference, integrations, and account-data processing separately |
| “You control what it remembers.” | After direct controls, scoped access, corrections, and deletion behavior pass acceptance; explain transcript/backup limitations |
| “Export your knowledge in open formats.” | After the documented knowledge-only format and import round-trip exist; the illustrative marketing JSON is not evidence |
| “Move your working agent to another host.” | After a real independent restore and task continuation, with integration reauthentication limits disclosed |
| “Only you can read it,” “zero knowledge,” or “end-to-end encrypted agent.” | Not supportable for the current managed architecture |
| “Cannot be stolen,” “100% secure,” or “deleted everywhere instantly.” | Do not use absolute guarantees |
| “Never used for training” or “zero retention.” | Requires verified terms and settings for every relevant processor; do not infer this from BYOK, EU hosting, or encryption |

## Required controls and evidence

Before live launch, verify encrypted tenant/control disks and backup locations, enforce MFA and least-privilege cloud credentials, restrict administrative access, and record exceptional access without copying private content into logs. Establish patching, recovery, incident response, and monitored deletion deadlines. Test stolen-backup recovery boundaries and document who holds each key.

For the personal KB, enforce authorization outside model prompts and across file/tool paths. Keep credentials outside knowledge-only exports. Configure and verify local indexing without silent remote fallback. Record selected model/embedding destinations and their retention/training terms; disclose changes before routing data elsewhere.

Publish the customer notice, processor list, retention schedule, recovery/key-loss behavior, and cancellation/export window against the deployed system. A security review and live acceptance evidence are still required. These documents do not change any release-evidence flag.

## Target wording after implementation and verification

> You control what your agent remembers. Your knowledge is stored in an isolated environment, encrypted in storage and transit, and exportable in open formats. We explain administrator access and which AI providers receive your context.

Pair that wording with an accessible disclosure that the hosting operator can access active tenant data. Until the relevant controls pass acceptance, use “We are building…” wording and describe individual implemented capabilities precisely.
