import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import type { DB } from "../src/db.js";
import { articles, articlePath } from "../src/content/articles.js";

const origin = "https://agent.test";
const makeApp = (indexing: boolean) =>
  buildApp(
    {
      PUBLIC_ORIGIN: origin,
      SEARCH_INDEXING_ENABLED: indexing,
      BILLING_MODE: "test",
      CHECKOUT_ENABLED: false,
      CREDITS_ENABLED: false,
    } as Config,
    {
      query: async () => {
        throw Error("Public content must not query customer data");
      },
    } as unknown as DB,
    [],
  );

test("public journal is rendered without JavaScript with valid metadata and working local links", async (t) => {
  const app = await makeApp(true);
  t.after(() => app.close());
  const paths = [
    "/welcome/",
    "/welcome/blog/",
    "/welcome/compare/",
    ...articles.map(articlePath),
  ];
  const titles = new Set<string>();
  const descriptions = new Set<string>();
  const localLinks = new Set<string>();
  for (const path of paths) {
    const response = await app.inject({
      url: path,
      headers: { host: "untrusted.test", "x-forwarded-host": "untrusted.test" },
    });
    assert.equal(response.statusCode, 200, path);
    assert.match(response.headers["content-type"]!, /text\/html/);
    assert.equal(response.headers["x-robots-tag"], "index,follow");
    assert.match(response.body, /<meta name="robots" content="index,follow">/);
    assert.ok(
      response.body.includes(`<link rel="canonical" href="${origin + path}">`),
    );
    assert.doesNotMatch(response.body, /untrusted\.test|noindex/);
    assert.equal((response.body.match(/<h1[ >]/g) || []).length, 1, path);
    titles.add(response.body.match(/<title>(.*?)<\/title>/s)![1]);
    descriptions.add(
      response.body.match(/name="description"\s+content="([^"]+)"/s)![1],
    );
    for (const match of response.body.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = new URL(match[1].replaceAll("&amp;", "&"), origin + path);
      if (url.origin === origin) localLinks.add(url.pathname);
    }
    const article = articles.find((a) => articlePath(a) === path);
    if (article) {
      assert.ok(response.body.includes(article.answer));
      const structured = [
        ...response.body.matchAll(
          /<script type="application\/ld\+json">(.*?)<\/script>/gs,
        ),
      ].map((m) => JSON.parse(m[1]));
      const graph = structured[0]["@graph"];
      assert.equal(graph[0].headline, article.title);
      assert.equal(graph[0].mainEntityOfPage, origin + path);
      assert.equal(graph[0].author.name, "Your Agent");
      assert.equal(graph[1].itemListElement.at(-1).item, origin + path);
      assert.match(
        response.body,
        /<meta property="og:type" content="article">/,
      );
    }
    for (const alias of [path.slice(0, -1), path + "index.html"]) {
      const redirect = await app.inject(alias);
      assert.equal(redirect.statusCode, 301);
      assert.equal(redirect.headers.location, path);
    }
  }
  assert.equal(titles.size, paths.length);
  assert.equal(descriptions.size, paths.length);
  for (const path of localLinks)
    assert.equal((await app.inject(path)).statusCode, 200, path);
  const sitemap = await app.inject("/sitemap.xml");
  const urls = [...sitemap.body.matchAll(/<loc>(.*?)<\/loc>/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    urls,
    paths.map((p) => origin + p),
  );
  assert.ok(!urls.includes(origin + "/"));
  const robots = await app.inject("/robots.txt");
  assert.match(robots.body, /User-agent: \*\nDisallow: \/\nAllow: \/welcome\//);
  assert.ok(robots.body.includes(`Sitemap: ${origin}/sitemap.xml`));
  const portal = await app.inject("/?mode=byok");
  assert.equal(portal.headers["x-robots-tag"], "noindex,nofollow");
  assert.equal(
    (await app.inject("/api/catalog")).headers["x-robots-tag"],
    "noindex,nofollow",
  );
  const missing = await app.inject("/welcome/blog/does-not-exist/");
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.headers["x-robots-tag"], "noindex,nofollow");
});

test("previews remain non-indexable with no URLs advertised in their sitemap", async (t) => {
  const app = await makeApp(false);
  t.after(() => app.close());
  for (const path of [
    "/welcome/",
    "/welcome/blog/",
    ...articles.map(articlePath),
  ]) {
    const response = await app.inject(path);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-robots-tag"], "noindex,nofollow");
    assert.match(response.body, /name="robots" content="noindex,nofollow"/);
  }
  assert.equal(
    (await app.inject("/robots.txt")).body,
    "User-agent: *\nDisallow: /\n",
  );
  assert.doesNotMatch((await app.inject("/sitemap.xml")).body, /<loc>/);
});
