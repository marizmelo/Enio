import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { renderMarkdownish } from "@/lib/markdown";

/**
 * One turn. User text is rendered through the same escaping path as model
 * output -- it is echoed back into innerHTML either way, so treating it as
 * trusted just because the user typed it would be a mistake.
 */
export function Message({ role, content, tools = [], error = false, streaming = false }) {
  const isUser = role === "user";

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

      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground",
          error && "bg-destructive/10 text-destructive",
          // A trailing block cursor while tokens are still arriving, so a slow
          // first token reads as "thinking" rather than as nothing happening.
          streaming &&
            "after:ml-0.5 after:inline-block after:h-4 after:w-1.5 after:translate-y-0.5 after:animate-pulse after:bg-current",
        )}
        dangerouslySetInnerHTML={{ __html: renderMarkdownish(content) }}
      />
    </div>
  );
}
