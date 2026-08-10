import { BookMarked, History, MessageSquarePlus } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TipButton } from "@/components/TipButton";
import { cn } from "@/lib/utils";

const DOT = {
  ready: "bg-emerald-500",
  failed: "bg-destructive",
  starting: "bg-amber-500 animate-pulse",
};

/**
 * Backend lifecycle, pushed from the main process over IPC. It stays visible
 * rather than disappearing once ready, because the one question this window
 * cannot answer on its own is whether the model is actually up.
 */
export function StatusBar({ phase, message, tools, context, onNewChat, onHistory, onRecipes }) {
  return (
    // The window uses titleBarStyle "hiddenInset", so macOS draws its traffic
    // lights over the top-left of the page rather than in a title bar of its
    // own. Nothing reserves that space automatically -- the left padding is
    // what keeps the status dot from sitting underneath the close button.
    // Dragging is restored here too, since with the title bar hidden this
    // strip is the only thing left to move the window by.
    <header
      className="flex shrink-0 items-center gap-3 border-b py-2.5 pr-4 pl-[86px] text-xs text-muted-foreground [-webkit-app-region:drag]"
    >
      <span className="shrink-0 text-sm font-semibold text-foreground">Enio</span>

      {/* no-drag, or the click starts a window drag instead: the whole bar is
          a drag region because the title bar is hidden. */}
      <div className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]">
        <TipButton tip="New chat" className="size-7" onClick={onNewChat}>
          <MessageSquarePlus className="size-3.5" />
        </TipButton>
        <TipButton tip="Conversations" className="size-7" onClick={onHistory}>
          <History className="size-3.5" />
        </TipButton>
        {/* Only on a Mac: recipes are AppleScript, so the list is empty and
            unfillable anywhere else, and a button opening an empty drawer
            teaches nobody anything. */}
        {onRecipes && (
          <TipButton tip="Recipes" className="size-7" onClick={onRecipes}>
            <BookMarked className="size-3.5" />
          </TipButton>
        )}
      </div>

      {/* Status sits right, and shrinks first: the title is one word and always
          fits, while the message can be a full sentence about a failure. */}
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <ContextMeter context={context} />
        <span className="truncate">{message}</span>
        {typeof tools === "number" && (
          <span className="shrink-0 tabular-nums">· {tools} tools</span>
        )}
        <span className={cn("size-2 shrink-0 rounded-full", DOT[phase] ?? DOT.starting)} />
      </div>
    </header>
  );
}

/**
 * How full the model's usable window is.
 *
 * The budget is not the model's 128k limit, which it cannot actually use --
 * measured recall of a planted fact falls from 4/4 at 1.5k tokens to 0/4 at
 * 12k. It is the band where the model still remembers what it was told, so
 * "full" here means "about to be summarised", not "about to error". Hidden
 * until a conversation is underway, since a meter reading zero teaches nobody
 * anything.
 */
function ContextMeter({ context }) {
  if (!context?.tokens) return null;
  const pct = Math.min(100, Math.round((context.tokens / context.budget) * 100));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                pct >= 90 ? "bg-amber-500" : "bg-muted-foreground/50",
              )}
              style={{ width: `${Math.max(pct, 4)}%` }}
            />
          </div>
          <span className="tabular-nums">{pct}%</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {context.tokens.toLocaleString()} / {context.budget.toLocaleString()} tokens of
        working context. Older turns are summarised past this.
      </TooltipContent>
    </Tooltip>
  );
}
