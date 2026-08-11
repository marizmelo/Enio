/**
 * Which pages a turn actually read.
 *
 * The model is handed titles, URLs and snippets and then writes a paragraph
 * from them. What reaches the window is the paragraph — so a claim and an
 * invention look identical, and at this model size that is not a hypothetical.
 * Naming the pages puts the check back within reach: one glance says whether
 * the answer came from anywhere.
 *
 * Recovered from what the tool returned rather than reported by the tool
 * itself, deliberately. The alternative is a second return channel threaded
 * through every web tool and kept in step with the text — for a display
 * nicety, where a missed source costs a missing row and nothing else. What the
 * model saw is exactly what is parsed here, which is also the honest thing to
 * show: this is the evidence, not a parallel account of it.
 */

export interface Source {
  url: string;
  title: string;
  snippet?: string;
}

/** Only these tools reach the web, so only these can contribute a source. */
const WEB_TOOLS = new Set(["web_search", "web_fetch", "web_fetch_rendered", "browse"]);

export function isWebTool(name: string): boolean {
  return WEB_TOOLS.has(name);
}

/**
 * `1. Title\n   https://…\n   snippet` — the shape web_search prints. Anchored
 * to the numbered-line format rather than scanning for bare URLs, so a URL
 * quoted inside a snippet does not become a result of its own.
 */
const SEARCH_HIT = /^\s*\d+\.\s+(.+)\n\s+(https?:\/\/\S+)\n?([\s\S]*?)(?=\n\s*\d+\.\s|\s*$)/gm;

export function extractSources(
  name: string,
  args: Record<string, unknown>,
  result: string,
): Source[] {
  if (!isWebTool(name) || !result) return [];

  if (name === "web_search") {
    const hits: Source[] = [];
    for (const [, title, url, snippet] of result.matchAll(SEARCH_HIT)) {
      hits.push({
        url: url!.trim(),
        title: title!.trim(),
        snippet: snippet?.trim().replace(/\s+/g, " ").slice(0, 300) || undefined,
      });
    }
    return hits;
  }

  // A fetch already knows its own URL from the call, which beats parsing it
  // back out -- and is still right when the fetch failed and the result is an
  // error string rather than a page.
  const url = typeof args.url === "string" ? args.url : firstUrl(result);
  if (!url || !/^https?:\/\//i.test(url)) return [];
  // Anything that reads like a failure is not a source. Citing a page the turn
  // could not read would be worse than citing nothing.
  if (/^(Fetch failed|Rendered fetch failed|Search failed|Error:)/m.test(result)) return [];

  return [{ url, title: titleFrom(result, url) }];
}

function firstUrl(text: string): string | null {
  return /https?:\/\/\S+/.exec(text)?.[0] ?? null;
}

/**
 * The title these tools print on the line above the URL, or the host.
 *
 * browse prefixes a data-marker line before the title, so the URL is found
 * first and the line above it is read back — which works for both shapes
 * without either needing to know about the other.
 */
function titleFrom(result: string, url: string): string {
  const lines = result.split("\n");
  const at = lines.findIndex((line) => line.trim() === url.trim());
  const above = at > 0 ? lines[at - 1]!.trim() : "";
  if (above && !above.startsWith("[") && !/^https?:\/\//.test(above)) return above.slice(0, 200);
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Same page cited twice is one source. First mention wins, because it is the
 *  one carrying a search snippet. */
export function dedupeSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const source of sources) {
    const key = source.url.replace(/[#?].*$/, "").replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}
