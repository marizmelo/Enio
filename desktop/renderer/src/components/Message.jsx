import { Badge } from "@/components/ui/badge";
import { Thinking } from "@/components/Thinking";
import { Widget } from "@/components/Widget";
import { AttachmentPreviews } from "@/components/AttachmentPreviews";
import { SourcesFooter } from "@/components/Sources";
import { MessageActions } from "@/components/MessageActions";
import { Info, Plug } from "lucide-react";
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
  agent = null,
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
      {(agent || tools.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {/* Who answered, stated by the harness rather than by the reply --
              the router's pick decides which tools even existed this turn,
              so a reply that could not do something is only explicable with
              it. Same rule as the MCP badge: provenance a model cannot
              misattribute. */}
          {agent && (
            <Badge variant="outline" className="text-[11px]">
              @{agent}
            </Badge>
          )}
          {countCalls(tools).map(({ name, calls }) => {
            // `server__tool` is the wire format every MCP tool is named by
            // (wireName in tools/mcp.ts); no built-in contains the separator,
            // and a test pins that. Naming the server here is the honest
            // channel for provenance: the reply is written by a model that
            // will claim third-party content as its own, this is not.
            const at = name.indexOf("__");
            const server = at > 0 ? name.slice(0, at) : null;
            return (
              <Badge
                key={name}
                variant="secondary"
                className="font-mono text-[11px]"
                title={server ? `from the "${server}" MCP connection` : undefined}
              >
                {server && <Plug className="mr-1 inline size-3 opacity-60" />}
                {server ? `${server} · ${name.slice(at + 2)}` : name}
                {calls > 1 && <span className="ml-1 opacity-60">×{calls}</span>}
              </Badge>
            );
          })}
        </div>
      )}


      {/* Images come BEFORE the text: the text is a reading of the picture,
          so the evidence sits above the claim — see the shot first, then what
          the model made of it. Other widgets stay below (the text is the
          answer; they are a quicker view of the same answer). */}
      {widgets.some((w) => w.type === "image") && (
        <div className="flex w-full max-w-[85%] flex-col gap-2">
          {widgets
            .filter((w) => w.type === "image")
            .map((w, i) => (
              <Widget key={`image-${i}`} widget={w} onOpenFile={onOpenFile} />
            ))}
        </div>
      )}

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
          onClick={onBodyClick}
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

      <SourcesFooter sources={sources} onOpenFile={onOpenFile} />

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
      {widgets.some((w) => w.type !== "image") && (
        <div className="flex w-full max-w-[85%] flex-col gap-2">
          {widgets
            .filter((w) => w.type !== "image")
            .map((w, i) => (
              <Widget key={`${w.type}-${i}`} widget={w} onOpenFile={onOpenFile} />
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
/**
 * Clicks inside the rendered answer.
 *
 * The body is injected as a string, so there is no React left to hang a
 * handler on and both of these arrive by delegation. A link goes to the real
 * browser through the main process: the renderer has no navigation of its own,
 * and a page loading inside the chat window would be a trap with no way back.
 */
function onBodyClick(event) {
  const link = event.target.closest("a[data-link]");
  if (link) {
    event.preventDefault();
    window.maple?.openExternal(link.getAttribute("href"));
    return;
  }
  copyCodeBlock(event);
}

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
