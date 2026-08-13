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
  /** Empty for a file: there is nothing to open in a browser. */
  url: string;
  title: string;
  snippet?: string;
  /** Web unless stated. A file row opens in the viewer, not the browser. */
  kind?: "web" | "file";
  /** The path as the tools address it, for a file source. */
  path?: string;
}

/** Only these tools reach the web, so only these can contribute a source. */
const WEB_TOOLS = new Set(["web_search", "web_fetch", "web_fetch_rendered", "browse"]);

/**
 * Tools that put the contents of a named file in front of the model.
 *
 * A closed list for the same reason WEB_TOOLS is one: a tool that merely
 * *lists* files (list_dir, search_code) did not hand over any content, and
 * citing it would claim a reading that never happened. Naming the file is the
 * point -- "read_file" on a badge says a file was read, not which one, and
 * "which document did this come from" is exactly the question a paragraph
 * about a document cannot answer for itself.
 */
const FILE_TOOLS = new Set(["read_file", "read_image"]);

export function isWebTool(name: string): boolean {
  return WEB_TOOLS.has(name);
}

export function isFileTool(name: string): boolean {
  return FILE_TOOLS.has(name);
}

/**
 * `1. Title\n   https://…\n   snippet` — the shape web_search prints.
 *
 * Anchored to the numbered-line format rather than scanning for bare URLs, so
 * a URL quoted inside a snippet does not become a result of its own. The
 * snippet is only the *indented* lines that follow: web_search appends the
 * text of the pages it read after the list, at column zero, and a greedy
 * capture would swallow a page of prose into the last result's snippet.
 */
const SEARCH_HIT = /^[ \t]*\d+\.[ \t]+(.+)\n[ \t]+(https?:\/\/\S+)\n?((?:[ \t]+\S.*\n?)*)/gm;

export function extractSources(
  name: string,
  args: Record<string, unknown>,
  result: string,
): Source[] {
  // Taken from the call rather than parsed back out of the text -- the same
  // argument web_fetch makes below, and it stays right when the read failed
  // and the result is an explanation instead of contents.
  if (isFileTool(name)) {
    const path = typeof args.path === "string" ? args.path.trim() : "";
    if (!path || fileUnusable(result)) return [];
    return [{ kind: "file", path, url: "", title: path }];
  }

  // A library hit put a chunk of the named file in front of the model, which
  // is a reading in the FILE_TOOLS sense -- and the answer's own prose cannot
  // be trusted to cite it (the MCP provenance measurement). The paths come
  // from the result rather than the args because one search names many files.
  if (name === "library_search") {
    if (!result || /^Nothing in the library matches/m.test(result)) return [];
    const hits: Source[] = [];
    for (const [, path] of result.matchAll(/^\[[^\]\n]+\] (.+)$/gm)) {
      hits.push({ kind: "file", path: path!.trim(), url: "", title: path!.trim() });
    }
    return hits;
  }

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
  if (unusable(result)) return [];

  const title = titleFrom(result, url);
  // A soft 404 -- an error page served with status 200 -- renders like any
  // other page, so the status check upstream never sees it and the title is
  // the only tell left. Narrow on purpose: an article genuinely called "Page
  // Not Found" is a rarer thing than a site that cannot be bothered to set a
  // status code, and the cost of being wrong here is one missing row.
  if (/^(404\b|page not found\b|not found\b)/i.test(title)) return [];

  return [{ url, title }];
}

/**
 * Whether the result is a failure rather than a page.
 *
 * Citing a page the turn could not read is worse than citing nothing: it makes
 * an answer look sourced when the source is an error message. The HTTP line
 * covers browse and web_fetch_rendered, which now refuse a 4xx or 5xx outright
 * rather than handing the model somebody's error template as content.
 */
const UNUSABLE = [
  /^(Fetch failed|Rendered fetch failed|Search failed|Error:)/m,
  /returned HTTP [45]\d\d/,
  /loaded but had no readable text/,
  /is not a valid URL|not permitted|redirected to a local or internal address/,
];

function unusable(result: string): boolean {
  return UNUSABLE.some((pattern) => pattern.test(result));
}

/**
 * A read that produced no readable content is not a source.
 *
 * Citing an unreadable PDF or a missing file would make an answer look
 * grounded in a document the turn never actually read -- the precise failure
 * this footer exists to catch, so it must not manufacture it.
 */
const FILE_UNUSABLE = [
  /^Error:/m,
  /is a binary file/,
  /is a scanned PDF/,
  /could not be parsed/,
  /^ENOENT|no such file/i,
];

function fileUnusable(result: string): boolean {
  return !result || FILE_UNUSABLE.some((pattern) => pattern.test(result));
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
 *  one carrying a search snippet. Files key on their path: every file source
 *  has an empty url, and keying those on url collapsed *different* files into
 *  one row -- found when library_search started returning several at once. */
export function dedupeSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const source of sources) {
    const key =
      source.kind === "file"
        ? `file:${source.path ?? ""}`
        : source.url.replace(/[#?].*$/, "").replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}
