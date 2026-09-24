# Search and AI discovery

Six editorial pages target distinct questions, with a journal and comparison hub. The current product name is Your Agent; no placeholder brand or speculative domain is included. Content is in `src/content/articles.ts`; routing and HTML metadata are in `src/content/routes.ts`. Edit the source content and review date when the facts change.

| URL                                                 | Primary intent                                       |
| --------------------------------------------------- | ---------------------------------------------------- |
| `/welcome/blog/why-personally-owned-ai-agents/`     | personally owned AI agent; why own your AI           |
| `/welcome/blog/free-open-source-personal-ai-agent/` | free open-source personal AI agent; real costs       |
| `/welcome/blog/local-vs-hosted-ai-agents/`          | local AI agent; self-hosted versus managed AI        |
| `/welcome/blog/portable-ai-memory/`                 | portable AI memory; export and migrate agent context |
| `/welcome/compare/muse-alternative/`                | Meta Muse alternative; open-source Muse alternative  |
| `/welcome/compare/grok-bot-alternative/`            | Grok Bot alternative; self-hosted personal agent     |

Every article has a short direct answer, substantive explanatory text, relevant internal links, product links and dated editorial attribution. Comparisons disclose that we build a competing product, distinguish documentation from hands-on evidence, and do not interpret missing documentation as missing capability. Free software is distinguished from free inference and free managed hosting. Local operation and production migration are not advertised as verified capabilities.

## Deployment

The current website is the backend's `/welcome/` surface, not the original private Sites snapshot. The existing Docker build compiles and includes all content; no generator or new runtime dependency is required.

1. Set `PUBLIC_ORIGIN` to the final public HTTPS origin. Canonicals, structured data and sitemap URLs all use that configured origin, never a request Host header.
2. Set `SEARCH_INDEXING_ENABLED=true` in the public deployment's environment and restart/redeploy the API. The setting defaults to false so preview deployments retain their existing noindex policy. Indexing is independent of checkout: editorial content can be public while billing stays disabled.
3. Confirm the public origin serves `/welcome/`, both hubs and all six articles without authentication. Check HTML and `X-Robots-Tag` both allow indexing, and confirm the reverse proxy does not add an overriding noindex header.
4. Confirm `/robots.txt` allows `/welcome/` and advertises `/sitemap.xml`. The sitemap lists nine canonical marketing pages. Account, API and unknown routes retain noindex headers and stay outside the sitemap. Robots directives are discovery preferences, not access controls.
5. Verify the domain in Google Search Console and submit `/sitemap.xml`. Inspect the homepage and both comparison URLs. This requires the final domain and Search Console ownership; the implementation does not imply submission or indexing has occurred.
6. When changing domains, redirect old public URLs permanently to their new equivalents and update `PUBLIC_ORIGIN`. Keep article paths stable.

The articles are ordinary server-rendered HTML, available with JavaScript disabled. Structured data matches visible content; there are no invented reviews, ratings, product availability claims or hidden keyword variants. The same response is delivered to people and crawlers. No special AI metadata file is required by Google's guidance, and none is treated as a ranking mechanism here.

## Evidence and measurement

Sources reviewed on 24 September 2026:

- [Google: AI features and your website](https://developers.google.com/search/docs/appearance/ai-features)
- [Meta's Muse announcement](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)
- [Grok Bot overview](https://docs.x.ai/grok-bot/overview)
- [OpenClaw documentation](https://docs.openclaw.ai/)
- [OpenClaw Ollama integration](https://docs.openclaw.ai/providers/ollama)
- [Open Source Definition](https://opensource.org/osd)
- [Your Agent public backend and license](https://github.com/Milbaxter/sovereign-agent-cloud)

After launch, measure indexed pages, non-brand query impressions and clicks, article-to-product visits, account creation and first useful task completion. AI citations and referrals are useful additional signals where observable; do not present them as a complete measurement of AI visibility. No trackers were added in this change. Rankings, indexing and AI citations cannot be guaranteed.

Expand the library when there is new evidence: a real migration walkthrough, a local-model benchmark on identified hardware, or a reproducible task comparison. Avoid separate near-duplicate pages for every permutation of “free”, “best”, “private” and “alternative”.
