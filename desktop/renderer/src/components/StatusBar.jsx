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
export function StatusBar({ phase, message, tools }) {
  return (
    // The window uses titleBarStyle "hiddenInset", so macOS draws its traffic
    // lights over the top-left of the page rather than in a title bar of its
    // own. Nothing reserves that space automatically -- the left padding is
    // what keeps the status dot from sitting underneath the close button.
    // Dragging is restored here too, since with the title bar hidden this
    // strip is the only thing left to move the window by.
    <header
      className="flex shrink-0 items-center gap-2 border-b py-2.5 pr-4 pl-[86px] text-xs text-muted-foreground [-webkit-app-region:drag]"
    >
      <span className={cn("size-2 shrink-0 rounded-full", DOT[phase] ?? DOT.starting)} />
      <span className="truncate">{message}</span>
      {typeof tools === "number" && (
        <span className="ml-auto shrink-0 tabular-nums">{tools} tools</span>
      )}
    </header>
  );
}
