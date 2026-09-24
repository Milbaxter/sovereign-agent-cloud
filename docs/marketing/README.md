# Marketing and launch materials

The landing page lives in `public/welcome/` and is served at `/welcome/` by the existing Fastify static handler. It is bundled by the existing Dockerfile's `COPY public ./public`; no separate build, hosting service, framework, or runtime dependency is required. The authenticated account portal remains at `/`, preserving email sign-in fragments, Stripe return URLs, and API routes.

## Purchase handoff

- The main page links to its pricing section, where the customer chooses BYOK or prepaid inference.
- The account link maps those choices to `/?mode=byok` and `/?mode=credits`.
- `/api/catalog` provides a public availability hint. Failed requests, malformed data, disabled checkout, test billing, and unavailable managed models never become a claim that live checkout is ready.
- Customers can still open the account portal when checkout is disabled. The portal performs login, provider/location consent, and account-bound checkout. Marketing never creates orders, changes credits, grants access, or sends secrets.
- A mode link is only a preselection. The portal remains responsible for reconfirming the mode and provider after email sign-in, including when the sign-in link opens on another device.
- The optional sign-in `mode` field preserves the inference preselection in the emailed link; checkout still requires explicit confirmation. The catalog applies the same release gate as checkout.

## What is included

- `brand.md`: freedom positioning, voice, logo, colour, type and imagery.
- `campaign.md`: founder post, short posts, freedom post, independence message, comparison replies, directory description.
- `recording-scripts.md`: real-product recording storyboard and three short clips.
- `outreach.md`: ten researched creators/publications, with pitch and follow-up drafts.
- `launch-calendar.md`: four-week sequence, interviews, and customer-example template.
- `measurement.md`: funnel, activation, retention, and reporting definitions; not a deployed analytics service.
- `unit-economics.md`: explicitly illustrative margin scenarios, not provider quotes.

All material is draft and unposted. Set `PUBLIC_URL` to the eventual public `/welcome/` URL when distributing copy. The original hosted design preview is not the product's production deployment. Keep `noindex` until a public launch is ready.

## Honest claims

Follow the [personal knowledge direction](../PERSONAL-KNOWLEDGE.md) and [privacy/security claims policy](../PRIVACY-SECURITY.md). Lead with “See what it knows. Change it. Take it with you.” as a clearly labeled product goal until the relevant controls pass acceptance. Editable knowledge, scoped access, knowledge-only export/import, and a device-held-key vault remain planned; do not present them as delivered. Preserve the distinction between an encrypted archive, encrypted live storage, and a service whose operator cannot read data.

The source is now public under Apache-2.0. This does not make every model open source or establish local inference, production hosting, complete restoration, or security acceptance. OpenClaw and third-party models retain their licenses. The walkthrough and downloadable JSON are explicitly illustrative, not live product evidence. Do not copy the illustrative export over the backend's encrypted real export.

The founder offer remains €25/month plus inference and applicable tax, with a proposed 12-month base-price guarantee for the first 50 customers. The backend limits distinct paid/reserved accounts, retains paid founders after deletion, and releases abandoned unpaid reservations. This is an account limit, not proof of unique real-world people; verify commercial terms and the configured limit before publishing the offer.

Release acceptance remains governed by `docs/VALIDATION.md` and `release-evidence.json`. These marketing files do not supply missing live evidence. Privacy, cancellation, operator access, and deletion copy must be reconciled with the verified deployment before paid launch.

## Assets and portability

The HTML, CSS, JavaScript, fonts and images are local; no remote fonts, advertising pixels, or third-party scripts are added. Fraunces and Inter are bundled under the SIL Open Font License (`public/welcome/fonts/`). `nordic-coast.jpg` (and its WebP crops `nordic-coast.webp`, `nordic-horizon.webp`, `nordic-pine.webp`) is an AI-generated illustrative landscape, not a verified picture of the data center or a particular Finnish location; the FAQ says so. The logo and favicon are local SVGs so they work under the backend's existing Content Security Policy, and `og-image.jpg` is the social share card. See the [brand guide](brand.md) for positioning, voice, logo, colour and type.

Edit the repository copy as the integration source of truth. Keep personal deployment logs, Sites metadata, credentials, and launch ZIPs out of the public repository.
