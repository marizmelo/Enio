import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "maple-web-"));
process.env.MAPLE_DATA_DIR = join(scratch, "data");
process.env.MAPLE_WORKSPACE = join(scratch, "workspace");
process.env.SEARXNG_URL = "http://127.0.0.1:8888";

const { extractReadable, htmlToText, isBlockedHost, activeProvider, buildWebTools } =
  await import("./tools/web.js");

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  rmSync(scratch, { recursive: true, force: true });
});

describe("content extraction", () => {
  const articlePage = `
    <html><head><title>Site Name — My Article</title></head>
    <body>
      <nav><a href="/">Home</a><a href="/about">About</a><a href="/blog">Blog</a></nav>
      <aside>Subscribe to our newsletter! Sign up now for updates.</aside>
      <article>
        <h1>Ternary Weights Explained</h1>
        <p>${"Ternary quantisation stores each weight as one of three values, which is what lets a twenty billion parameter model fit in five gigabytes. ".repeat(8)}</p>
        <p>${"The tradeoff is that training must account for the quantisation from the start rather than applying it afterwards. ".repeat(8)}</p>
      </article>
      <footer>Copyright 2026. All rights reserved. Privacy policy.</footer>
    </body></html>`;

  test("pulls the article and drops the chrome", async () => {
    const { text, byReadability } = await extractReadable(articlePage, "https://x.test/a");
    assert.equal(byReadability, true, "Readability should have handled this");
    assert.ok(text.includes("Ternary quantisation stores"), "body text should survive");
    assert.ok(!text.includes("Subscribe to our newsletter"), "aside should be dropped");
    assert.ok(!text.includes("Privacy policy"), "footer should be dropped");
  });

  test("falls back gracefully on pages with no article structure", async () => {
    const bare = `<html><body><div>Short bit of text.</div></body></html>`;
    const { text, byReadability } = await extractReadable(bare, "https://x.test/b");
    assert.equal(byReadability, false, "should fall back, not throw");
    assert.ok(text.includes("Short bit of text"));
  });

  test("survives malformed html", async () => {
    const broken = `<html><body><p>unclosed <div><span>tags everywhere`;
    const { text } = await extractReadable(broken, "https://x.test/c");
    assert.ok(text.length > 0);
  });

  test("regex fallback still strips scripts and decodes entities", () => {
    const text = htmlToText(
      `<body><script>alert(1)</script><p>Hello &amp; welcome &#8212; ok</p></body>`,
    );
    assert.ok(!text.includes("alert"));
    assert.ok(text.includes("Hello & welcome"));
  });
});

describe("search provider selection", () => {
  test("prefers SearXNG when its URL is set", () => {
    assert.equal(activeProvider(), "searxng");
  });

  test("exposes web_search once a provider exists", () => {
    const names = buildWebTools().map((t) => t.name);
    assert.ok(names.includes("web_search"));
    assert.ok(names.includes("web_fetch"));
  });

  test("explains the 403 rather than passing it through raw", async () => {
    globalThis.fetch = (async () => new Response("", { status: 403 })) as typeof fetch;
    const search = buildWebTools().find((t) => t.name === "web_search")!;
    const result = await search.run({ query: "anything" });
    assert.match(result, /JSON output is disabled/);
    assert.match(result, /settings\.yml/);
  });

  test("parses a SearXNG result payload", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { title: "Maple", url: "https://hf.co/deepgrove", content: "A ternary <b>MoE</b>" },
            { title: "Other", url: "https://example.com", content: "Something else" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const search = buildWebTools().find((t) => t.name === "web_search")!;
    const result = await search.run({ query: "maple", count: 2 });
    assert.match(result, /1\. Maple/);
    assert.match(result, /https:\/\/hf\.co\/deepgrove/);
    assert.ok(!result.includes("<b>"), "html should be stripped from snippets");
  });
});

describe("fetch safety", () => {
  test("refuses loopback and private hosts", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254"]) {
      assert.equal(isBlockedHost(h), true, `${h} should be blocked`);
    }
  });

  test("handles bracketed ipv6 loopback", () => {
    assert.equal(isBlockedHost("[::1]"), true);
  });

  test("allows ordinary public hosts", () => {
    for (const h of ["example.com", "172.32.5.5", "9.9.9.9"]) {
      assert.equal(isBlockedHost(h), false, `${h} should be allowed`);
    }
  });

  test("web_fetch rejects a blocked host before making a request", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const fetchTool = buildWebTools().find((t) => t.name === "web_fetch")!;
    const result = await fetchTool.run({ url: "http://169.254.169.254/latest/meta-data/" });
    assert.match(result, /not permitted/);
    assert.equal(called, false, "must not have issued a request");
  });

  test("web_fetch rejects non-http schemes", async () => {
    const fetchTool = buildWebTools().find((t) => t.name === "web_fetch")!;
    assert.match(await fetchTool.run({ url: "file:///etc/passwd" }), /only http and https/);
  });

  test("suggests the rendered fetch when a page yields no text", async () => {
    globalThis.fetch = (async () =>
      new Response(`<html><body><div id="root"></div><script>renderApp()</script></body></html>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;

    const fetchTool = buildWebTools().find((t) => t.name === "web_fetch")!;
    const result = await fetchTool.run({ url: "https://spa.example.com" });
    assert.match(result, /web_fetch_rendered/);
  });
});
