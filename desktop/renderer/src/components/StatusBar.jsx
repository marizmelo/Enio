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
    <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5 text-xs text-muted-foreground">
      <span className={cn("size-2 shrink-0 rounded-full", DOT[phase] ?? DOT.starting)} />
      <span className="truncate">{message}</span>
      {typeof tools === "number" && (
        <span className="ml-auto shrink-0 tabular-nums">{tools} tools</span>
      )}
    </header>
  );
}
