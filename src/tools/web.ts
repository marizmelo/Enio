import { config } from "../config.js";
import type { ToolDef } from "../types.js";
import { renderPage, playwrightAvailable } from "./browser.js";

/**
 * Web access.
 *
 * Search resolves through providers in priority order: a self-hosted SearXNG
 * instance first, then Brave, then Tavily. SearXNG is preferred because it needs
 * no key and no account — it aggregates ~70 engines behind one local API, and
 * absorbs the maintenance burden of engines changing their markup, which is the
 * part you really don't want to own yourself.
 *
 * Scraping Google or Bing directly is deliberately not offered. It violates
 * their terms, it breaks constantly because they actively defend against it, and
 * a headless browser only delays that rather than solving it.
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

export type SearchProvider = "searxng" | "brave" | "tavily" | null;

export function activeProvider(): SearchProvider {
  if (config.searxngUrl) return "searxng";
  if (config.braveApiKey) return "brave";
  if (config.tavilyApiKey) return "tavily";
  return null;
}

async function runSearch(query: string, count: number): Promise<SearchHit[]> {
  switch (activeProvider()) {
    case "searxng": return searxngSearch(query, count);
    case "brave":   return braveSearch(query, count);
    case "tavily":  return tavilySearch(query, count);
    default:        throw new Error("No search provider configured.");
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

/** The model reads untrusted page content, and that content can tell it to
 *  fetch things. Loopback, private ranges and cloud metadata stay unreachable. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;
  if (h === "169.254.169.254" || h === "metadata.google.internal") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === "::1") return true;
  return false;
}

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
      return hits
        .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet.slice(0, 300)}`)
        .join("\n\n");
    } catch (err) {
      return `Search failed: ${(err as Error).message}`;
    }
  },
};

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
      const html = await renderPage(target.href, {
        waitFor: args.wait_for ? String(args.wait_for) : undefined,
      });
      const { title, text } = await extractReadable(html, target.href);
      return clip(`${title ? title + "\n" : ""}${target.href}\n\n${text}`);
    } catch (err) {
      return `Rendered fetch failed: ${(err as Error).message}`;
    }
  },
};

export function buildWebTools(): ToolDef[] {
  const tools: ToolDef[] = [];
  if (activeProvider()) tools.push(searchTool);
  tools.push(fetchTool);
  if (playwrightAvailable()) tools.push(renderedFetchTool);
  return tools;
}
