# Website handoff

The marketing site is included in `public/welcome/` and served at `/welcome/`. The account portal stays at `/` so existing email sign-in fragments, Stripe return URLs, and API routes keep working. The existing Dockerfile includes both surfaces. Launch copy and recording/outreach materials are in [marketing](marketing/README.md). No Stripe products or live checkout settings are changed by the site integration.

The marketing purchase button points to the same-origin account portal, with the inference selection mapped to `/?mode=byok` or `/?mode=credits`. The portal verifies the customer's email, records inference/provider consent, and calls `POST /api/checkout`. That endpoint returns a Stripe Checkout Session URL containing a server-bound order. Deployment still needs the €25 monthly recurring price and €10 one-time credit price IDs, both EUR and tax-exclusive, plus verified Stripe tax configuration. Do not use an unbound Payment Link: the earlier launch-kit suggestion predates the authenticated order contract.

The backend creates Checkout Sessions and processes Stripe events. The marketing site never handles secrets or calls privileged provisioning endpoints. To preselect a purchase mode, link `/?mode=byok` or `/?mode=credits`; the portal still requires explicit provider/location selection. A customer returning from Stripe sees provisioning status; the return URL never grants entitlement.

Register `/webhooks/stripe` for:

- `invoice.paid`, `invoice.payment_failed`
- `customer.subscription.updated`, `customer.subscription.deleted`
- `checkout.session.completed`, `checkout.session.async_payment_succeeded`
- `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`

Preserve the raw request body for signature verification. This implementation uses a dedicated raw-body route. Test and live modes require separate deployments, databases, signing keys, and resource labels.

`GET /api/catalog` provides price disclosures, verified managed models, locations, and published rates. `GET /api/me` provides account-scoped status and wallet totals (integer micro-euros serialized as strings). `docs/openapi.json` contains the public contract.

The landing page reads only `/api/catalog`, without credentials, to describe availability. It distinguishes test billing, disabled checkout, unavailable credit models, and failed catalog requests. Opening the portal remains possible in every state; navigation does not grant payment or agent access. The marketing page never requests `/api/me` or calls checkout itself. There are no new APIs, external scripts, trackers, or frontend secrets. Its local SVG favicon works with the backend's existing Content Security Policy.

Checkout remains disabled by default. Managed models remain unverified until real tool-call, streaming usage, and OpenClaw acceptance tests pass. Production live checkout also requires documented evidence for every release gate. Do not label the site demo/export as real evidence until the corresponding tests are recorded.

Price guarantee: this backend does not schedule a price increase; the Stripe price stays fixed. The founding cohort defaults to 50 outstanding/active tenant slots, with expired abandoned orders released by maintenance. Configure tax and cancellation copy consistently with the account portal before launch.
