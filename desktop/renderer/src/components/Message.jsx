import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Widget } from "@/components/Widget";
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
  error = false,
  streaming = false,
}) {
  const isUser = role === "user";
  const waiting = streaming && !isUser && !error && content.length === 0;

  return (
    <div className={cn("flex flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
      {tools.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tools.map((name, i) => (
            <Badge key={`${name}-${i}`} variant="secondary" className="font-mono text-[11px]">
              {name}
            </Badge>
          ))}
        </div>
      )}

      {waiting ? (
        // Nothing has arrived yet. The gap before the first visible token is
        // not dead time -- the model is generating a <think> block that gets
        // stripped before it ever reaches here, and on a long one that is tens
        // of seconds of a bubble that would otherwise sit empty.
        <div className="flex max-w-[85%] items-center gap-2 rounded-lg bg-muted px-3.5 py-2.5 text-sm text-muted-foreground">
          <Spinner />
          <span>Thinking…</span>
        </div>
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
          dangerouslySetInnerHTML={{ __html: renderMarkdownish(content) }}
        />
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
