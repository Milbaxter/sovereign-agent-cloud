# Personal knowledge that belongs to the user

Status: accepted product direction; implementation and acceptance work remain. Reviewed 24 September 2026. This document does not enable features or establish production security evidence.

## Product promise

An agent becomes more useful as it understands a person's projects, preferences, relationships, and goals. That accumulated knowledge must remain understandable and useful when the person changes models, hosting providers, or agent applications.

**See what it knows. Change it. Take it with you.**

Provide a first-class “Your knowledge” view. Users can browse, search, add, edit, import, and remove information without asking the model to do it. Show which sources informed an answer. Distinguish what the user confirmed from what the agent inferred; a plausible inference is not a fact about someone.

## Existing foundation and missing work

The current service runs stock OpenClaw on one VM per owner or trusted group. It exports complete state encrypted to a supplied age recipient and maintains separately encrypted operational backups. A synthetic export/restore has been exercised locally. Production migration remains unverified; see [validation](VALIDATION.md).

The service does not yet provide the knowledge controls, knowledge-only export/import contract, enforced per-item permissions, local-only indexing policy, or device-held-key vault described below. A trusted family/company group is not a set of private member accounts.

[OpenClaw Memory Wiki](https://docs.openclaw.ai/plugins/memory-wiki) documents provenance, structured claims, contradiction checks, wiki tools, and Obsidian-compatible Markdown. Evaluate it against the pinned runtime before adding a second memory engine. Current upstream documentation is not proof that every feature works in our pinned image. Record that compatibility exercise before enabling it by default.

## Knowledge model and controls

Keep canonical knowledge in readable Markdown, original attachments, and versioned JSON metadata with a documented schema. Search indexes and embeddings are derived, replaceable data. They must not be the only surviving copy of a memory.

Each item needs a stable ID, type, creation/update time, source references, confirmation status, scope, and sensitivity policy. Preserve links through export/import. Keep generated summaries distinguishable from original documents and user-authored text. Edits should preserve provenance without retaining deleted sensitive content indefinitely in revision history.

The product should support:

- Profiles, preferences, projects, people, goals, and source documents, with an explicit distinction between user statements and agent suggestions.
- Reviewable proposed memories. Sensitive inferences require explicit confirmation before becoming durable knowledge. Users can disable automatic capture and use a session without adding durable memories; transcript retention is disclosed separately.
- A visible “context used” record with source links, model destination, and explanations of retrieval. Record identifiers and decisions rather than duplicating private content in central logs.
- Per-agent/task access grants and explicit sharing into group conversations. A model instruction or a sensitivity label alone is not access control.
- Corrections, stale/conflicting information, and an understandable deletion preview. An edited fact must not silently be overwritten by an older imported source.

Implement authorization in the retrieval/file-access layer before information reaches the model. An agent with unrestricted shell access to the entire vault could bypass a retrieval filter; scope file mounts, tool access, and credentials as well. Imported documents are untrusted content and cannot grant themselves permission to read or transmit private material.

## Portability contract

Offer two distinct exports:

| Export | Contents | Purpose |
| --- | --- | --- |
| Knowledge-only | Markdown, selected original files, source relationships, and versioned metadata | Reuse knowledge in another application without giving it account secrets |
| Complete agent backup | Existing quiesced state, configuration, sessions, and credentials, encrypted to the owner's recipient | Restore the runtime on another host |

Knowledge-only export must exclude provider keys, auth stores, cookies, environment secrets, and hidden credentials. User-authored documents can themselves contain secrets: show the selected contents and offer review; do not promise automatic redaction is perfect. Let users include or omit transcripts explicitly. Encryption should be the default for downloaded archives, with readable contents after decryption and clear key recovery guidance.

Publish a versioned format, manifest, file checksums, and sample fixture using synthetic data. Import must validate versions, sizes, paths, and checksums; reject traversal and unsafe symlinks, never execute imported content, and preview duplicates/conflicts before changing existing knowledge. Preserve IDs or maintain an explicit mapping. Rebuild derived indexes after import.

Demonstrate three separate outcomes: changing the inference provider, restoring OpenClaw on another host, and importing knowledge into another agent application. Success at one does not prove the others. External integrations may need reauthentication. Keep export available through the documented suspension/retention period.

## Forgetting and retention

“Forget this” must identify the selected fact/source and attributable summaries, wiki pages, search chunks, embeddings, caches, and revisions. Let the user decide whether to remove original transcripts/files too. A retained source can recreate a deleted fact; either remove it or enforce an exclusion during later indexing and consolidation.

Deletion must be resumable and report completion and limitations. Apply deletion exclusions before serving a restored backup. Keep any deletion ledger minimal: opaque IDs rather than the forgotten text. Account deletion and deletion of a single fact have different workflows.

Disclose remaining copies in exports, backups, external model services, and connected apps. Existing code retains seven daily backup objects; that is not an instant erasure guarantee or a guaranteed seven-day deadline if jobs stop running. Publish and monitor an actual expiry deadline before launch. Never silently combine indefinite immutable backup retention with immediate-erasure promises.

[OpenClaw's memory deletion documentation](https://docs.openclaw.ai/releases/2026.8.1/memory) explicitly distinguishes attributable derived memory from original transcripts, untracked notes, exports, and backups. Our UI must preserve those distinctions.

## Security architecture

The initial managed service uses encrypted storage and backups, local indexing where verified, restricted administrative access, and explicit model-provider disclosure. See [privacy and security claims](PRIVACY-SECURITY.md). Administrators remain technically able to read active tenant data. Do not call this end-to-end encrypted or zero-knowledge hosting.

Configure the memory embedding provider explicitly. Prefer on-VM embeddings or keyword-only retrieval, with no silent remote fallback. Check indexing, imports, summaries, background memory jobs, model calls, and tools separately: local retrieval does not make a remote reasoning model local. Confirm the settings against the pinned runtime and observe network destinations during acceptance.

A future optional private vault could hold decryption keys only on the user's devices. Encrypted synchronization would leave the server holding ciphertext, while local search selects information the user releases for a task. Once released to a cloud agent/model, that information crosses the boundary. An unattended cloud agent cannot freely read a locked vault; disclose that availability tradeoff. Recovery must not introduce an undisclosed operator-held decryption key. A lost key can mean unrecoverable data. Device compromise and malicious client updates remain relevant risks.

Confidential computing is a separate research option requiring verified provider support, remote attestation, key release policy, and an analysis of the inference path. No such capability has been established for this deployment.

## Implementation sequence and acceptance

These are planned slices, not completed checkboxes. Each implementation PR should attach synthetic test evidence and update validation without marking live release gates passed from mocks.

1. **Storage baseline:** explicitly request and verify encrypted tenant disks, inventory existing/control disks, test encrypted backup recovery, and document key custody. Provider encryption does not remove operator access.
2. **Runtime capability check:** evaluate Memory Wiki and memory settings on the pinned image; verify local indexing and network behavior. Decide whether an adapter suffices before choosing another engine.
3. **Knowledge controls:** build browse/edit/import/review and source attribution. Test correction persistence and unauthorized cross-user, cross-agent, and group recall. Reject access through file/shell tools as well as search.
4. **Portable knowledge:** document the format and implement knowledge-only export/import. Round-trip synthetic notes, attachments, provenance, edits, and deletions; scan the exported archive for seeded credentials. Demonstrate use outside this service, not just a download.
5. **Deletion and recovery:** remove attributable derived content, prevent reintroduction, test interrupted deletion and restoration of an older backup, and monitor retention expiry. Explain which external copies cannot be recalled.
6. **Private vault exploration:** prototype device-held keys, local search, explicit context release, recovery, and offline behavior before making a stronger confidentiality promise.

Launch evidence must include an independent threat-model/security review covering account takeover, compromised administrators/control services, stolen backup storage, cross-tenant access, malicious imported content, and tool exfiltration. Encryption is one control within that review.
