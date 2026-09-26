# Customer readiness improvements — 26 September 2026

This change improves failure recovery, setup guidance and performance visibility. It does not enable checkout, verify a managed model, approve a release gate or deploy a service.

## Account and setup experience

- Catalog and account reads run concurrently to avoid an extra sequential round trip. Malformed responses leave the last valid view intact.
- Account polling retries after network, catalog and account-service failures. A transient error preserves the signed-in view and entered values; only a real 401 clears the account view. A separate status message explains stale data and disappears after recovery.
- Export and SSH inputs survive status changes for the same tenant. They are cleared when the tenant or signed-in session changes.
- Actions show a busy state and suppress repeat submissions while the request runs. Network requests have deadlines, non-JSON responses fail safely, and error messages explain recovery. Mutations are never automatically retried because a lost response does not mean the action failed.
- Provisioning text explains what is happening and that customers can return later. Onboarding has three numbered steps, explicit new-tab guidance, and an account link.
- Browser approval appears only for one session-matched pending device. Empty/multiple results get instructions; stale details clear before another lookup. Device metadata is tucked into a disclosure. Server-side session/device verification remains unchanged.
- Clipboard failures give permission guidance without printing the Gateway token. Small-screen spacing and busy-state accessibility are improved.

The OpenClaw terminal wizard, provider-key setup and dashboard connection still exist. This is an incremental improvement, not a claim of one-click onboarding. The existing Playwright runner's exact Copy Gateway token label and pairing success message are retained.

## Managed inference timing

The API emits one structured `inference_timing` log after each reserved managed inference request finishes or fails. It contains only a generated request ID, streaming flag, fixed outcome/settlement labels and numeric durations. It excludes prompts, answers, tool arguments, credentials, provider error text, email and tenant IDs.

Durations are milliseconds from the inference pre-handler, including authentication and reservation work:

| Field                  | Meaning                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `headersMs`            | Provider response headers arrived; null if no response                                             |
| `firstUpstreamChunkMs` | First nonempty streamed provider chunk; null for non-streaming/no chunk                            |
| `generationMs`         | Provider body completed; null on failure                                                           |
| `totalMs`              | Processing through settlement completion/failure                                                   |
| `outcome`              | `completed`, `failed`, or `client_disconnected`                                                    |
| `settlement`           | `processed` or `failed`; processed may include quarantined unknown usage, not necessarily a charge |

First chunk is **not** guaranteed to contain a visible token. These logs exclude browser rendering, messaging delivery, BYOK requests and requests rejected before a spending reservation. They are diagnostics, not a customer latency SLA. Normal application logging adds timestamp/process metadata; retain operational logs under the operator's access/retention policy.

After deployment, collect a bounded log window and calculate p50/p95 separately for streaming/non-streaming and successful/failed requests. Correlate generated request IDs with existing billing records only when diagnosing an issue. Measure user-visible first text and full completion separately in the authorized customer journey, including a warm chat, contextual follow-up, tool call, provider failure and concurrent sessions. Record the deployment digest, model, region, sample size and error rate alongside results.

## Validation and outstanding work

Local regression tests cover polling outages/recovery, session expiry, preserving/clearing form values, duplicate clicks, malformed responses, browser pairing states and clipboard failures. A real local HTTP streaming test with a controlled synthetic provider verifies that the first chunk reaches the client before the provider finishes, then verifies metering and the exact content-free timing fields. Provider failure tests verify no completed-generation claim and continued usage quarantine.

These tests use disposable local PostgreSQL and synthetic provider data. No cloud resources, messages, payments or paid inference are involved. Visual browser acceptance, payment-to-agent journeys, real provider latency, backup recovery, monitoring delivery and the pilot remain outstanding. The separate customer-journey branch still needs its bootstrap safeguards reviewed and its approved live run completed.
