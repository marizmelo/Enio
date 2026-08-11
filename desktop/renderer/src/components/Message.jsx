import { Badge } from "@/components/ui/badge";
import { Thinking } from "@/components/Thinking";
import { Widget } from "@/components/Widget";
import { AttachmentPreviews } from "@/components/AttachmentPreviews";
import { SearchResults, SourcesFooter } from "@/components/Sources";
import { MessageActions } from "@/components/MessageActions";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { renderMarkdownish } from "@/lib/markdown";

/**
 * One turn. User text is rendered through the same escaping path as model
 * output -- it is echoed back into innerHTML either way, so treating it as
 * trusted just because the user typed it would be a mistake.
 */
export function Message({
  role,
  content,
  tools = [],
  widgets = [],
  sources = [],
  files = [],
  notices = [],
  thinking = 0,
  startedAt = null,
  error = false,
  streaming = false,
  onOpenFile,
}) {
  const isUser = role === "user";
  const waiting = streaming && !isUser && !error && content.length === 0;

  return (
    <div className={cn("flex flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
      {isUser && files.length > 0 && <AttachmentPreviews names={files} onOpen={onOpenFile} />}
      {tools.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {countCalls(tools).map(({ name, calls }) => (
            <Badge key={name} variant="secondary" className="font-mono text-[11px]">
              {name}
              {calls > 1 && <span className="ml-1 opacity-60">×{calls}</span>}
            </Badge>
          ))}
        </div>
      )}

      {/* What the searches returned, above the answer written from them. A
          model this size summarises loosely, and the hits are both the check
          on that and often the thing actually wanted. */}
      {searchHits(sources).length > 0 && <SearchResults items={searchHits(sources)} />}

      {waiting ? (
        <Thinking startedAt={startedAt} chars={thinking} />
      ) : (
        <div
          className={cn(
            "max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed",
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-foreground",
            error && "bg-destructive/10 text-destructive",
            // A trailing block cursor once tokens are arriving, so a pause
            // mid-answer still reads as movement.
            streaming &&
              "after:ml-0.5 after:inline-block after:h-4 after:w-1.5 after:translate-y-0.5 after:animate-pulse after:bg-current",
          )}
          onClick={copyCodeBlock}
          dangerouslySetInnerHTML={{ __html: renderMarkdownish(content) }}
        />
      )}

      {/* Only once the answer is complete: buttons that appear mid-stream
          invite copying half a sentence. A user's own message is always
          complete, and worth copying too -- a long prompt is often the thing
          you want to reuse or edit. Reading it back is not, so that button is
          only on the replies. */}
      {!waiting && !streaming && !error && content.trim() && (
        <MessageActions content={content} canSpeak={!isUser} />
      )}

      <SourcesFooter sources={sources} />

      {/* Addressed to the reader, not the model: how the attachment was read
          and what would read it better. Kept out of the prompt on purpose --
          telling the model its eyesight is limited makes it announce the
          limitation rather than answer. */}
      {notices.length > 0 && (
        <div className="flex w-full max-w-[85%] flex-col gap-1">
          {notices.map((n, i) => (
            <div
              key={i}
              className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
            >
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span className="[&>code]:rounded [&>code]:bg-muted [&>code]:px-1">{n}</span>
            </div>
          ))}
        </div>
      )}

      {/* Below the text, never instead of it. The sentence is the answer; this
          is the same answer in a form that is quicker to read. */}
      {widgets.length > 0 && (
        <div className="flex w-full max-w-[85%] flex-col gap-2">
          {widgets.map((w, i) => (
            <Widget key={`${w.type}-${i}`} widget={w} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Copy a fenced code block.
 *
 * Delegated from the container because the markdown is injected as a string
 * and there is no element to attach a handler to. Routed through the main
 * process for the same reason the message-level copy is: the renderer's
 * clipboard API is blocked under this CSP.
 */
async function copyCodeBlock(event) {
  const button = event.target.closest("[data-copy-code]");
  if (!button) return;
  const code = button.closest("div")?.parentElement?.querySelector("code");
  if (!code) return;
  await window.maple?.copyText(code.textContent ?? "");
  const previous = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = previous;
  }, 1200);
}

/**
 * One badge per tool, with how many times it ran.
 *
 * A turn that searches four times used to print four identical badges, which
 * says nothing the first one did not and pushes everything else down the
 * screen. Ordered by first use, so the row still reads as the sequence of what
 * happened rather than as an alphabetised inventory.
 */
function countCalls(tools) {
  const order = [];
  const counts = new Map();
  for (const name of tools) {
    if (!counts.has(name)) order.push(name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return order.map((name) => ({ name, calls: counts.get(name) }));
}

/** Hits from searches only. A fetched page is a source but not a result --
 *  it was already chosen, so listing it as something to choose is noise. */
function searchHits(sources) {
  return (sources ?? []).filter((s) => s.tool === "web_search").flatMap((s) => s.items ?? []);
}
