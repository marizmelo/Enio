import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { createRequire } from "node:module";

/**
 * The chat renderer, tested from the Node suite.
 *
 * It lives in the desktop renderer and has no dependencies, so it imports
 * directly rather than needing a browser. It is worth testing here because it
 * feeds dangerouslySetInnerHTML: the escaping *is* the sanitiser, and links
 * were the first thing added that puts attacker-influenced text into an
 * attribute rather than into a text node.
 */
const require = createRequire(import.meta.url);
const markdownPath = require.resolve("../desktop/renderer/src/lib/markdown.js");
const { renderMarkdownish } = await import(markdownPath);

describe("links in a reply", () => {
  test("markdown links become anchors", () => {
    const html = renderMarkdownish("The [JBL Flip 7](https://example.com/flip7) is £120.");
    assert.match(html, /<a href="https:\/\/example\.com\/flip7" data-link/);
    assert.match(html, />JBL Flip 7<\/a>/);
  });

  test("bare urls become anchors, shortened, without eating the full stop", () => {
    const html = renderMarkdownish("Read https://www.example.com/a/b. Then stop.");
    assert.match(html, /href="https:\/\/www\.example\.com\/a\/b"/);
    assert.match(html, />example\.com\/a\/b<\/a>\. Then stop\./);
  });

  /**
   * The body is injected with dangerouslySetInnerHTML and the text it renders
   * came off a web page. A link is the one place a URL lands in an attribute,
   * so the scheme has to be checked -- escaping alone would leave a working
   * javascript: link.
   */
  test("only http(s) is ever made clickable", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,<b>x", "file:///etc/passwd"]) {
      const html = renderMarkdownish(`[click](${href})`);
      assert.ok(!/<a /.test(html), `${href} should not become a link: ${html}`);
    }
  });

  test("markup inside link text stays text", () => {
    const html = renderMarkdownish("[<img src=x onerror=alert(1)>](https://e.com/1)");
    assert.ok(!/<img/.test(html));
    assert.match(html, /&lt;img/);
  });

  test("a quote in the url cannot close the href attribute", () => {
    const html = renderMarkdownish('[x](https://e.com/a" onmouseover="alert(1))');
    assert.ok(!/onmouseover="alert/.test(html));
  });

  test("urls inside code are left alone", () => {
    assert.ok(!/<a /.test(renderMarkdownish("`https://example.com/x`")));
    assert.ok(!/<a /.test(renderMarkdownish("```\ncurl https://example.com/x\n```")));
  });
});
