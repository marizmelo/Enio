import { config } from "../config.js";
import type { ToolDef } from "../types.js";
import { isBlockedHost, renderPage, playwrightAvailable } from "./browser.js";
export { isBlockedHost };

/**
 * Web access.
 *
 * Search resolves through providers in priority order: a self-hosted SearXNG
 * instance, then Brave, then Tavily, then DuckDuckGo's own no-JavaScript
 * endpoint. The first three are chosen deliberately and win when configured;
 * the last needs nothing at all, which is the point of it.
 *
 * DuckDuckGo is last but not optional, because the alternative was worse than
 * a fragile provider: with no key and no Docker, `web_search` was withheld
 * entirely and the model was left to reach the web through `web_fetch` and
 * `browse` -- which means guessing a URL. Watching a 4B model guess
 * cnet.com/best-products/best-bluetooth-speakers-under-150-dollars, land on a
 * 404 and report that the page does not exist is what this exists to stop. A
 * search that sometimes fails beats a URL that is always a guess.
 *
 * Scraping Google or Bing is still deliberately not offered. They actively
 * defend against it and a headless browser only delays the breakage. DDG
 * publishes this endpoint for clients without JavaScript, it is plain HTML
 * over a plain fetch with no browser involved, and when it does break the
 * failure is one provider returning nothing rather than a wrong answer.
 */

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/* ---------- providers --------------------------------------------------- */

async function searxngSearch(query: string, count: number): Promise<SearchHit[]> {
  const url = new URL("/search", config.searxngUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "en");

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });

  if (res.status === 403) {
    throw new Error(
      `SearXNG returned 403. JSON output is disabled by default — add "json" ` +
        `under search.formats in settings.yml and restart it.`,
    );
  }
  if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);

  const data = (await res.json()) as any;
  return (data?.results ?? []).slice(0, count).map((r: any) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: stripTags(r.content ?? ""),
  }));
}

async function braveSearch(query: string, count: number): Promise<SearchHit[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": config.braveApiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Brave search failed: ${res.status}`);
  const data = (await res.json()) as any;
  return (data?.web?.results ?? []).map((r: any) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: stripTags(r.description ?? ""),
  }));
}

async function tavilySearch(query: string, count: number): Promise<SearchHit[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: config.tavilyApiKey, query, max_results: count }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Tavily search failed: ${res.status}`);
  const data = (await res.json()) as any;
  return (data?.results ?? []).map((r: any) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: stripTags(r.content ?? ""),
  }));
}

export type SearchProvider = "searxng" | "brave" | "tavily" | "duckduckgo";

export function activeProvider(): SearchProvider {
  if (config.searxngUrl) return "searxng";
  if (config.braveApiKey) return "brave";
  if (config.tavilyApiKey) return "tavily";
  return "duckduckgo";
}

/**
 * DuckDuckGo's HTML-only endpoint, which exists for clients that cannot run
 * JavaScript and is therefore a plain document rather than an app.
 *
 * Parsed with regular expressions on purpose. A DOM parser here would be more
 * correct and no more durable -- the thing that breaks is the class names, not
 * the nesting -- and this is one page shape, not arbitrary HTML.
 *
 * Sponsored rows are dropped. They are marked as such in the markup, and an
 * advert presented to a model as a search result is an advert it will
 * summarise as a recommendation.
 */
const DDG_LITE = "https://lite.duckduckgo.com/lite/";
const RESULT_LINK = /<a[^>]+href=["']([^"']+)["'][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/i;
const RESULT_SNIPPET = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i;

async function duckduckgoSearch(query: string, count: number): Promise<SearchHit[]> {
  const res = await fetch(`${DDG_LITE}?${new URLSearchParams({ q: query })}`, {
    headers: {
      // A real browser string. The endpoint serves a different, emptier page
      // to something that announces itself as a script.
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
  return parseDuckDuckGo(await res.text(), count);
}

/** Exported for tests: the parse is the fragile half, and it should be
 *  checkable against a saved page rather than against the live web. */
export function parseDuckDuckGo(html: string, count: number): SearchHit[] {
  const hits: SearchHit[] = [];
  let pending: SearchHit | null = null;
  for (const row of html.split(/<tr\b/i)) {
    const sponsored = /class=["']?result-sponsored/.test(row);
    const link = RESULT_LINK.exec(row);
    if (link) {
      pending = null;
      if (sponsored) continue;
      const url = unwrapRedirect(decodeEntities(link[1]!));
      // Everything DDG links to itself is navigation, help or an ad.
      if (!/^https?:\/\//.test(url) || /(^|\.)duckduckgo\.com/.test(hostOf(url))) continue;
      pending = { title: decodeEntities(stripTags(link[2]!)), url, snippet: "" };
      hits.push(pending);
      continue;
    }
    // The snippet is in a sibling row, so it attaches to the link just seen.
    const snippet = RESULT_SNIPPET.exec(row);
    if (snippet && pending && !sponsored) {
      pending.snippet = decodeEntities(stripTags(snippet[1]!));
      pending = null;
    }
  }
  return hits.slice(0, count);
}

/** DDG wraps outbound links as /l/?uddg=<encoded>. The real URL is the point. */
function unwrapRedirect(href: string): string {
  const wrapped = /[?&]uddg=([^&]+)/.exec(href);
  const url = wrapped ? decodeURIComponent(wrapped[1]!) : href;
  return url.startsWith("//") ? `https:${url}` : url;
}

/** The host, or "" when the string is not a URL at all. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function runSearch(query: string, count: number): Promise<SearchHit[]> {
  switch (activeProvider()) {
    case "searxng": return searxngSearch(query, count);
    case "brave":   return braveSearch(query, count);
    case "tavily":  return tavilySearch(query, count);
    default:        return duckduckgoSearch(query, count);
  }
}

/* ---------- extraction -------------------------------------------------- */

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Content extraction using Firefox reader mode's algorithm, which scores DOM
 * nodes by text density and link ratio to find the actual article. Much better
 * than tag-stripping, which cannot tell a nav sidebar from a paragraph.
 *
 * Falls back to the regex path when Readability declines — it returns null on
 * pages with no article-like structure, which is common for docs sites and
 * search results, and those still have text worth reading.
 */
export async function extractReadable(
  html: string,
  url: string,
): Promise<{ title: string; text: string; byReadability: boolean }> {
  try {
    const [{ parseHTML }, { Readability }] = await Promise.all([
      import("linkedom"),
      import("@mozilla/readability"),
    ]);
    const { document } = parseHTML(html);
    // Readability resolves relative links against this.
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);

    const article = new Readability(document as never, { charThreshold: 200 }).parse();
    if (article?.textContent && article.textContent.trim().length > 200) {
      return {
        title: article.title ?? "",
        text: article.textContent.replace(/\n{3,}/g, "\n\n").trim(),
        byReadability: true,
      };
    }
  } catch {
    /* fall through to the regex path */
  }
  return { title: titleOf(html), text: htmlToText(html), byReadability: false };
}

function titleOf(html: string): string {
  return stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
}

/** Crude but dependency-free fallback extraction. */
export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  text = text.replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n");
  return text.trim();
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  };
  return s
    .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, c: string) => String.fromCodePoint(parseInt(c, 16)));
}

/* ---------- host safety ------------------------------------------------- */

// isBlockedHost lives in browser.ts (the network layer both fetch and the
// live session share) and is re-exported below, so this module's callers and
// tests keep importing it from here.
function parseTarget(raw: string): URL | string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return `Error: "${raw}" is not a valid URL.`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Error: only http and https URLs are supported.";
  }
  if (isBlockedHost(parsed.hostname)) return "Error: that host is not permitted.";
  return parsed;
}

function clip(text: string): string {
  if (text.length <= config.maxToolOutputChars) return text;
  return text.slice(0, config.maxToolOutputChars) + `\n\n[truncated]`;
}

/* ---------- tools ------------------------------------------------------- */

const searchTool: ToolDef = {
  name: "web_search",
  description:
    "Search the web and get back a ranked list of titles, URLs and snippets. Use this to find pages; use web_fetch to read one.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      count: { type: "number", description: "How many results (1-10). Default 5." },
    },
    required: ["query"],
  },
  async run(args) {
    const query = String(args.query ?? "").trim();
    if (!query) return "Error: empty query.";
    const count = Math.min(10, Math.max(1, Number(args.count ?? 5) || 5));
    try {
      const hits = await runSearch(query, count);
      if (hits.length === 0) return `No results for "${query}".`;

      const list = hits
        .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet.slice(0, 300)}`)
        .join("\n\n");

      const read = await readTopResults(hits);
      return read ? `${list}\n\n${read}` : list;
    } catch (err) {
      return `Search failed: ${(err as Error).message}`;
    }
  },
};

/**
 * Read the top few results, in the same call that found them.
 *
 * A search returns titles and one-line snippets, which is enough to *choose* a
 * page and nowhere near enough to answer from. The intended sequence is search
 * then fetch, and a model this size reliably stops after the first step and
 * writes a summary of the snippets -- which reads like an answer, cites real
 * pages, and is assembled from search-engine blurbs rather than from anything
 * the pages actually say.
 *
 * So the second step is not left to the model. This is the same closed-list
 * move as everything else here: a decision it gets wrong becomes something it
 * does not have to make. It costs one round of fetches, which is cheaper than
 * the follow-up turn it replaces.
 *
 * Bounded hard, because the context budget is small and measured -- three
 * pages at 1500 characters is roughly 1k tokens on top of the list. Failures
 * are silent: a page that will not load simply is not quoted, and the list on
 * its own is what the model had before.
 */
const READ_TOP = 3;
const READ_CHARS = 1500;

async function readTopResults(hits: SearchHit[]): Promise<string> {
  const pages = await Promise.all(hits.slice(0, READ_TOP).map((hit) => readArticle(hit)));
  const usable = pages.filter((p): p is string => p !== null);
  if (usable.length === 0) return "";
  return `Page contents — answer from these, not from the snippets above.\n\n${usable.join("\n\n")}`;
}

async function readArticle(hit: SearchHit): Promise<string | null> {
  // Through the same guard a hand-typed URL goes through. These addresses come
  // from a search engine, so they are exactly the untrusted case it exists for.
  const target = parseTarget(hit.url);
  if (typeof target === "string") return null;
  try {
    const res = await fetch(target, {
      headers: { "User-Agent": "enio/0.1 (+local)" },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    if (!(res.headers.get("content-type") ?? "").includes("html")) return null;

    const { text } = await extractReadable(await res.text(), target.href);
    const trimmed = text.trim();
    // Under a paragraph means the extractor found navigation, not an article.
    if (trimmed.length < 200) return null;
    const clipped = trimmed.slice(0, READ_CHARS);
    return `--- ${hit.url}\n${clipped}${trimmed.length > READ_CHARS ? "\n…" : ""}`;
  } catch {
    return null;
  }
}

const fetchTool: ToolDef = {
  name: "web_fetch",
  description:
    "Fetch a web page and return its main article text, with navigation and boilerplate removed. Fast. If the result looks empty or the page needs JavaScript, use web_fetch_rendered instead.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute http(s) URL." } },
    required: ["url"],
  },
  async run(args) {
    const target = parseTarget(String(args.url ?? ""));
    if (typeof target === "string") return target;
    try {
      const res = await fetch(target, {
        headers: { "User-Agent": "enio/0.1 (+local)" },
        signal: AbortSignal.timeout(20_000),
        redirect: "follow",
      });
      if (!res.ok) return `Fetch failed: HTTP ${res.status}`;

      const type = res.headers.get("content-type") ?? "";
      const body = await res.text();
      if (!type.includes("html")) return clip(`${target.href}\n\n${body}`);

      const { title, text } = await extractReadable(body, target.href);
      if (text.trim().length < 100) {
        return (
          `${target.href}\n\n[Very little text extracted — this page probably renders ` +
          `its content with JavaScript. Try web_fetch_rendered.]\n\n${text}`
        );
      }
      return clip(`${title ? title + "\n" : ""}${target.href}\n\n${text}`);
    } catch (err) {
      return `Fetch failed: ${(err as Error).message}`;
    }
  },
};

const renderedFetchTool: ToolDef = {
  name: "web_fetch_rendered",
  description:
    "Fetch a web page using a real browser, running its JavaScript first. Slower than web_fetch — use it only when web_fetch returned little or no text, or the page is an app rather than a document.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL." },
      wait_for: {
        type: "string",
        description: "Optional CSS selector to wait for before reading the page.",
      },
    },
    required: ["url"],
  },
  async run(args) {
    const target = parseTarget(String(args.url ?? ""));
    if (typeof target === "string") return target;
    try {
      const { html, status } = await renderPage(target.href, {
        waitFor: args.wait_for ? String(args.wait_for) : undefined,
      });
      // Same reason as browse: a rendered 404 is a page like any other to a
      // browser, and its error template reads as content to the model.
      if (status >= 400) {
        return (
          `Rendered fetch failed: HTTP ${status} — there is no page at ${target.href}. ` +
          `Use web_search to find the right URL.`
        );
      }
      const { title, text } = await extractReadable(html, target.href);
      return clip(`${title ? title + "\n" : ""}${target.href}\n\n${text}`);
    } catch (err) {
      return `Rendered fetch failed: ${(err as Error).message}`;
    }
  },
};

export function buildWebTools(): ToolDef[] {
  // Always offered now: there is a provider that needs no configuration, so
  // there is no state in which searching is impossible while fetching is not.
  const tools: ToolDef[] = [searchTool, fetchTool];
  if (playwrightAvailable()) tools.push(renderedFetchTool);
  return tools;
}
