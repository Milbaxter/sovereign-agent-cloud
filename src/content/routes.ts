import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { articles, articlePath, reviewedAt } from "./articles.js";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const jsonLd = (data: object) =>
  `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;

const shareImage = "/welcome/og-image.jpg";
const brand = (href: string) =>
  `<a href="${href}" class="brand" aria-label="Your Agent home"><img class="brand-mark" src="/welcome/logo-mark.svg" alt="" width="36" height="36"><span class="brand-word">your agent<span class="brand-period">.</span></span></a>`;

export function contentRoutes(app: FastifyInstance, c: Config) {
  // Configured origin only: request Host and forwarded headers cannot poison canonicals.
  const origin = new URL(c.PUBLIC_ORIGIN).origin;
  const indexing = c.SEARCH_INDEXING_ENABLED === true;
  const robots = indexing ? "index,follow" : "noindex,nofollow";
  const paths = [
    "/welcome/",
    "/welcome/blog/",
    "/welcome/compare/",
    ...articles.map(articlePath),
  ];
  const metadata = (
    path: string,
    title: string,
    description: string,
    type = "website",
  ) => `
    <meta name="robots" content="${robots}">
    <link rel="canonical" href="${escape(origin + path)}">
    <meta property="og:url" content="${escape(origin + path)}">
    <meta property="og:type" content="${type}">
    <meta property="og:title" content="${escape(title)}">
    <meta property="og:description" content="${escape(description)}">
    <meta property="og:image" content="${escape(origin + shareImage)}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:image" content="${escape(origin + shareImage)}">
    <meta name="twitter:title" content="${escape(title)}">
    <meta name="twitter:description" content="${escape(description)}">`;
  const cards = (items: typeof articles) =>
    `<div class="reading-grid">${items
      .map(
        (a) => `
    <article class="reading-card"><p class="eyebrow">${a.section === "blog" ? "FIELD NOTES" : "ALTERNATIVES"}</p>
    <h2><a href="${articlePath(a)}">${escape(a.title)}</a></h2><p>${escape(a.description)}</p>
    <a class="text-link" href="${articlePath(a)}">Read ${a.section === "blog" ? "article" : "comparison"} <span aria-hidden="true">↗</span></a></article>`,
      )
      .join("")}</div>`;
  const page = (
    path: string,
    title: string,
    description: string,
    body: string,
    structured: object,
    article = false,
  ) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} | Your Agent</title><meta name="description" content="${escape(description)}">
<meta name="theme-color" content="#0d1f52">${metadata(path, title, description, article ? "article" : "website")}
<link rel="icon" type="image/svg+xml" href="/welcome/favicon.svg"><link rel="stylesheet" href="/welcome/styles.css"><link rel="stylesheet" href="/welcome/reading.css">${jsonLd(structured)}</head>
<body class="reading-page"><a class="skip-link" href="#main">Skip to content</a>
<header class="site-header wrap">${brand("/welcome/")}
<nav aria-label="Main navigation"><a href="/welcome/blog/">Journal</a><a href="/welcome/compare/">Alternatives</a><a href="/welcome/#pricing">Pricing</a></nav><a class="button button-small" href="/welcome/">Explore Your Agent ↗</a></header>
<main id="main" class="wrap reading-main">${body}</main>
<footer class="site-footer"><div class="wrap footer-inner"><div class="footer-brand">${brand("/welcome/")}<p>Make it personal. Keep it yours.</p></div><nav class="footer-links" aria-label="Footer"><a href="/welcome/#freedom">Freedom</a><a href="/welcome/blog/">Journal</a><a href="/welcome/compare/">Alternatives</a><a href="/welcome/#pricing">Pricing</a><a href="https://github.com/Milbaxter/sovereign-agent-cloud">Source on GitHub ↗</a></nav></div></footer></body></html>`;
  const breadcrumbs = (path: string, section: string, title?: string) => {
    const trail = [
      {
        "@type": "ListItem",
        position: 1,
        name: "Your Agent",
        item: origin + "/welcome/",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: section,
        item:
          origin +
          (section === "Journal" ? "/welcome/blog/" : "/welcome/compare/"),
      },
    ];
    if (title)
      trail.push({
        "@type": "ListItem",
        position: 3,
        name: title,
        item: origin + path,
      });
    return { "@type": "BreadcrumbList", itemListElement: trail };
  };
  const sendPage = (path: string, html: string) => {
    app.get(path, async (_req, reply) =>
      reply
        .header("x-robots-tag", robots)
        .type("text/html; charset=utf-8")
        .send(html),
    );
    // One canonical route per document, including the static homepage alias.
    for (const alias of [path.slice(0, -1), path + "index.html"])
      app.get(alias, async (_req, reply) => reply.redirect(path, 301));
  };

  const home = readFileSync(resolve("public/welcome/index.html"), "utf8")
    .replace(/\s*<meta\s+name="robots"[^>]*>/, "")
    .replace(
      "</head>",
      `<meta name="robots" content="${robots}"><link rel="canonical" href="${escape(origin + "/welcome/")}"><meta property="og:url" content="${escape(origin + "/welcome/")}"><meta property="og:image" content="${escape(origin + shareImage)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${escape(origin + shareImage)}"></head>`,
    );
  sendPage("/welcome/", home);

  for (const section of ["blog", "compare"] as const) {
    const path = `/welcome/${section}/`;
    const title =
      section === "blog"
        ? "A personal AI you can keep"
        : "Find an agent that fits your idea of ownership";
    const label = section === "blog" ? "Journal" : "Alternatives";
    const description =
      section === "blog"
        ? "Practical notes on free software, local AI, portable memory and personally owned agents."
        : "Muse and Grok Bot alternatives, examined through software freedom, hosting choices and the context you can keep.";
    const items = articles.filter((a) => a.section === section);
    sendPage(
      path,
      page(
        path,
        title,
        description,
        `<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/welcome/">Your Agent</a> / ${label}</nav>
<header class="reading-intro"><p class="eyebrow">${label.toUpperCase()}</p><h1>${title}</h1><p>${description}</p></header>${cards(items)}
<aside class="reading-cta"><h2>${section === "blog" ? "Choosing between personal agents?" : "Start with the foundations."}</h2><p>${section === "blog" ? "Explore our Muse and Grok Bot comparisons." : "Read about local operation, free software and portable memory."}</p><a class="text-link" href="/welcome/${section === "blog" ? "compare" : "blog"}/">${section === "blog" ? "Explore alternatives" : "Read the journal"} ↗</a></aside>`,
        {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "CollectionPage",
              name: title,
              description,
              url: origin + path,
              mainEntity: {
                "@type": "ItemList",
                itemListElement: items.map((a, i) => ({
                  "@type": "ListItem",
                  position: i + 1,
                  name: a.title,
                  url: origin + articlePath(a),
                })),
              },
            },
            breadcrumbs(path, label),
          ],
        },
      ),
    );
  }
  for (const a of articles) {
    const path = articlePath(a);
    const label = a.section === "blog" ? "Journal" : "Alternatives";
    const body = `<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/welcome/">Your Agent</a> / <a href="/welcome/${a.section}/">${label}</a> / <span>${escape(a.title)}</span></nav>
<article class="reading-article"><header><p class="eyebrow">${label.toUpperCase()} · OWN YOUR AI</p><h1>${escape(a.title)}</h1><p class="byline">By Your Agent · Published and reviewed <time datetime="${reviewedAt}">24 September 2026</time></p><p class="direct-answer">${escape(a.answer)}</p></header>
<div class="article-body">${a.body}</div></article>
<aside class="reading-cta"><p class="eyebrow">Make it personal. Keep it yours.</p><h2>Freedom is the feature.</h2><p>Your Agent is an open-source personal agent with your choice of model and a context built to travel. See what’s built, what’s next and what it costs.</p><a class="button" href="/welcome/#freedom">Explore Your Agent ↗</a></aside>
<section class="related-reading" aria-label="Related reading"><h2>Keep reading</h2>${cards(a.related.map((slug) => articles.find((item) => item.slug === slug)!))}</section>`;
    sendPage(
      path,
      page(
        path,
        a.title,
        a.description,
        body,
        {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "BlogPosting",
              headline: a.title,
              description: a.description,
              datePublished: reviewedAt,
              dateModified: reviewedAt,
              inLanguage: "en",
              mainEntityOfPage: origin + path,
              url: origin + path,
              author: {
                "@type": "Organization",
                name: "Your Agent",
                url: origin + "/welcome/",
              },
              publisher: {
                "@type": "Organization",
                name: "Your Agent",
                url: origin + "/welcome/",
              },
            },
            breadcrumbs(path, label, a.title),
          ],
        },
        true,
      ),
    );
  }
  app.get("/robots.txt", async (_req, reply) =>
    reply
      .type("text/plain; charset=utf-8")
      .send(
        indexing
          ? `User-agent: *\nDisallow: /\nAllow: /welcome/\nAllow: /sitemap.xml\nSitemap: ${origin}/sitemap.xml\n`
          : "User-agent: *\nDisallow: /\n",
      ),
  );
  app.get("/sitemap.xml", async (_req, reply) =>
    reply
      .type("application/xml; charset=utf-8")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${indexing ? paths.map((path) => `<url><loc>${escape(origin + path)}</loc></url>`).join("") : ""}</urlset>`,
      ),
  );
}
