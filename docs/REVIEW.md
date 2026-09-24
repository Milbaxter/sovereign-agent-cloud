# Implementation and launch review — 24 September 2026

The project is a substantial working prototype, not a service ready to accept live customers. It has real billing, database, provisioning, export, and isolation machinery. Most acceptance evidence still uses synthetic state or provider doubles. A polished landing page and passing tests do not establish that a customer can pay, use an agent, and leave with it.

## Defects corrected

| Priority | Finding                                                                                                              | Correction and evidence                                                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | Retrying one Stripe order recomputed `expires_at`, changing parameters under the same idempotency key.               | Use Stripe's default expiry so repeated requests stay identical; regression advances the clock between requests. [Stripe's idempotency contract](https://docs.stripe.com/api/idempotent_requests). |
| High     | Export cleanup could restart OpenClaw after a concurrent suspension.                                                 | Suspend/resume share the archive operation lock; packaged smoke test runs overlapping backup and suspension and verifies the final stopped state.                                                  |
| High     | Existing tenant access sessions could still use local access endpoints after suspension.                             | Central session validation rejects suspended access sessions while preserving export sessions; new control-plane handoffs also require current entitlement.                                        |
| High     | Provider-supplied usage objects were stored wholesale, allowing extra prompt/content fields into billing records.    | Persist only validated token counters, including bounded reasoning-token counts; tests inject private text and verify it is absent from request and ledger records.                                |
| Medium   | The catalog advertised checkout from environment flags even when live release evidence rejected purchases.           | Catalog and checkout share the effective gate; missing/invalid evidence fails closed.                                                                                                              |
| Medium   | Email login dropped the selected inference mode; fresh authentication had no direct signed-in action.                | Carry an allowlisted mode in the email URL and add a fresh-link button. Provider consent remains at checkout.                                                                                      |
| Medium   | Status polling stopped at pending payment and rebuilt partially filled forms every ten seconds.                      | Poll pending payments and preserve forms while tenant data is unchanged; DOM interaction tests cover both.                                                                                         |
| Medium   | Tenant authorization used the proxy's shared address and limited asset authorization subrequests to 60/minute.       | Trust the sole loopback proxy hop and exempt the authenticated forward-auth route from throttling; packaged test performs 75 checks.                                                               |
| Medium   | “First 50 customers” was an active-slot limit that reopened after paid users left.                                   | Count distinct paid/reserved accounts; retain paid cohort places after deletion and release expired unpaid reservations. This is an account limit, not identity verification.                      |
| Medium   | Marketing and backend branches had diverged, and the original kit still included obsolete Payment Link instructions. | Integrate current main into the existing marketing PR; identify the repository as canonical and replace obsolete checkout instructions.                                                            |

## Product and marketing critique

The independence argument is clear, but the strongest selling point still lacks a customer-visible proof: a useful agent moved to a fresh host. The synthetic restore test is a useful engineering step, not that demonstration. Lead the eventual recording with one completed recurring task, then show retained context and a verified exit path.

The initial audience was too broad for the implemented experience. Provider setup, device pairing, and age-encrypted exports require more involvement than a mainstream one-click product. Begin with three to five individual users already comfortable with AI tools. A family or company currently shares one agent trust boundary; it is not a product with separate private member accounts. The landing page now says this explicitly and plainly discloses operator access.

Keep €25 as the proposed hosting price, but validate contribution after support, backup storage, and the cost of keeping canceled VMs during retention. The first-50 account cap is now enforced; the 12-month commercial guarantee still needs to be reflected in the actual offer and operating practice. No later price increase is implemented or invented.

## What still blocks launch

1. Supply the production domain and operator-controlled UpCloud, DNS, SMTP, Stripe, backup, and model configuration. Publish the tenant image, make it pullable, and pin its digest. The repository workflow exists; this review did not publish an image or deploy a service.
2. Record a real test-mode payment → exactly one VM → BYOK and managed-credit browser onboarding flow, including retry/restart failures. Stripe test cards still create billable cloud resources. No such resources were created in this review.
3. Verify actual inference rates, location, streaming/tool calls, channel connections, and complete browser/device-pairing behavior. Current model entries remain unverified. Browser visual/onboarding testing was previously blocked by the tool's admin-policy check and has not been represented as passing.
4. Verify independent-host restore, real backups, cancellation, failed renewal, recovery, deletion, and network isolation. Failed provisioning and exhausted jobs require a responding operator; alerts must be connected to actual monitoring before users depend on this service.
5. Supply the business identity, support contact, published service/privacy/retention terms, and measured pilot costs. The hosted design preview is not a Finnish production deployment. Broad launch and outreach remain premature.

## Verification and scope

44 automated tests pass against disposable PostgreSQL, plus the packaged tenant lifecycle smoke check. Typecheck, production build, formatting, JavaScript/shell syntax, Docker build, and dependency audit pass locally. CI now also builds and tests the packaged tenant service. The new tests are regression evidence, not a security certification or production acceptance.

No production credentials, customer data, charges, cloud resources, outreach, or deployment settings were changed. `release-evidence.json` remains false and models remain unverified. The reviewed source is on the existing marketing PR; merging and deployment are separate steps. Synced project references remain untouched.
