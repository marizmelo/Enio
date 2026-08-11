import { ExternalLink, Globe } from "lucide-react";

const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const open = (url) => window.maple?.openExternal(url);

/**
 * What the search actually returned, before the model wrote about it.
 *
 * A small model reads titles and snippets and produces a paragraph, and a
 * paragraph is where a summary and an invention become indistinguishable.
 * Showing the hits puts the check one glance away — and often answers the
 * question outright, since the right link beats a description of it.
 *
 * Not collapsed by default and not hidden behind the tool badge: it is
 * evidence, and evidence nobody opens is not evidence.
 */
export function SearchResults({ items }) {
  if (!items?.length) return null;

  return (
    <ol className="flex w-full max-w-[85%] flex-col gap-1.5">
      {items.map((item, i) => (
        <li key={`${item.url}-${i}`}>
          <button
            type="button"
            onClick={() => open(item.url)}
            className="group w-full rounded-md border bg-background/40 px-3 py-2 text-left hover:bg-muted/60"
          >
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-sm text-foreground group-hover:underline">
                {item.title}
              </span>
              <ExternalLink className="size-3 shrink-0 translate-y-0.5 text-muted-foreground" />
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {host(item.url)}
            </span>
            {item.snippet && (
              <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
                {item.snippet}
              </span>
            )}
          </button>
        </li>
      ))}
    </ol>
  );
}

/**
 * Every page the turn read, under the answer that came out of them.
 *
 * Deduped across tools, because searching and then fetching the top hit is the
 * normal path and citing it twice would say something untrue about how much
 * was consulted. First mention wins: that is the one carrying a snippet.
 *
 * Deliberately terse — one row per page, title and domain. This sits under
 * every answer that touched the web, so it has to be scannable at a glance and
 * silent when there is nothing to say.
 */
export function SourcesFooter({ sources }) {
  const items = [];
  const seen = new Set();
  for (const group of sources ?? []) {
    for (const item of group.items ?? []) {
      const key = item.url.replace(/[#?].*$/, "").replace(/\/$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  if (items.length === 0) return null;

  return (
    <div className="max-w-[85%]">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Globe className="size-3" />
        {items.length === 1 ? "Source" : `Sources · ${items.length}`}
      </p>
      <ol className="mt-1 flex flex-col gap-0.5">
        {items.map((item, i) => (
          <li key={`${item.url}-${i}`} className="flex items-baseline gap-1.5 text-xs">
            <span className="w-4 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">
              {i + 1}
            </span>
            <button
              type="button"
              onClick={() => open(item.url)}
              title={item.url}
              className="min-w-0 truncate text-left text-muted-foreground hover:text-foreground hover:underline"
            >
              {item.title}
              <span className="ml-1.5 text-[11px] opacity-70">{host(item.url)}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
