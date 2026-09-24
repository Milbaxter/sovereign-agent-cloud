# Measurement and first-month scorecard

Status: specification and reporting template. No analytics receiver exists in this workspace, and the preview does not transmit marketing events. Product events require the actual application. Do not count preview interactions as real agent usage.

## Definitions

| Metric                | Definition                                                                           | Evidence source                                                   |
| --------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Visits                | Landing-page sessions, excluding founder QA and bots                                 | Privacy-preserving server/analytics aggregates                    |
| Checkout starts       | Checkout link clicks; label these clicks, not successful sessions                    | Aggregate click count; Stripe sessions separately if available    |
| Purchases             | First successfully paid subscription invoice for a customer                          | Verified Stripe billing events; not the redirect page             |
| Activation            | First completed task the customer marks useful                                       | Application event without the task text                           |
| Following-week return | An activated paying account completes another useful task 7–13 days after activation | Application events joined by internal account ID, then aggregated |
| Support load          | Total support minutes / paid accounts                                                | Founder time log, no message contents                             |
| Contribution          | Hosting revenue less attributable infrastructure, payments, and support              | Actual invoices and support time; see unit-economics.md           |

Target: 10 paying customers, with at least 7 returning in the following week. Report the return rate only for customers old enough to have completed the 7–13-day observation window. Incomplete cohorts are “pending,” not failures or zeroes. Refunded/failed first payments do not count as paid customers.

## Event boundary

Allow event name, time, coarse campaign code, and—in the private application only—the account identifier needed to calculate retention. No prompts, message text, filenames, exports, API keys, payment details, raw referrer URLs, or arbitrary query-string contents. Do not use fingerprinting. Report aggregates to the marketing scorecard; raw account-level records stay within the product's documented access and retention policy.

Purchases and activation are server-confirmed events. Deduplicate payment events by their provider event/invoice identifiers. Do not trust query parameters claiming a purchase succeeded. Do not add a third-party tracking pixel to this privacy-focused page by default.

## Weekly scorecard

Blank values mean unmeasured, not zero. Populate from verified sources only.

| Week | Visits | Checkout clicks | New paid customers | Activated customers | Mature return cohort | Returned in days 7–13 | Support minutes/account | Contribution/account |
| ---- | ------ | --------------- | ------------------ | ------------------- | -------------------- | --------------------- | ----------------------- | -------------------- |
| 1    | —      | —               | —                  | —                   | —                    | —                     | —                       | —                    |
| 2    | —      | —               | —                  | —                   | —                    | —                     | —                       | —                    |
| 3    | —      | —               | —                  | —                   | —                    | —                     | —                       | —                    |
| 4    | —      | —               | —                  | —                   | —                    | —                     | —                       | —                    |

Interpretation: visits without checkout interest suggest the message or demonstration is weak; checkout interest without purchases suggests price, trust, or friction; purchases without activation suggest onboarding/product issues; activation without return suggests weak recurring usefulness. These are hypotheses for interviews, not proven causes.
