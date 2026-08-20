import { useCallback, useEffect, useState } from "react";
import { Square, TerminalSquare } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { listCommands, stopAllCommands, stopCommand } from "@/lib/commands";

/**
 * What the agent left running.
 *
 * A background command — a web server, a watch build — outlives the turn that
 * started it, which is the point and also the risk: a process on your machine
 * that you cannot see is one you cannot stop. This is the whole inventory,
 * with the command as it actually ran, where it ran, and what it printed.
 *
 * Polled while open rather than pushed: these start and die outside any
 * stream, and a list that quietly goes stale would be worse than no list.
 */
export function CommandsDialog({ open, onOpenChange, onChanged }) {
  const [commands, setCommands] = useState([]);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const list = await listCommands();
      setCommands(list);
      onChanged?.(list.length);
    } catch (err) {
      setError(String(err.message ?? err));
    }
  }, [onChanged]);

  useEffect(() => {
    if (!open) return;
    setError("");
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] flex-col gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Running processes</DialogTitle>
          <DialogDescription>
            Commands an agent started and left running. They stop when you quit Enio, or
            whenever you say so here.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
          {commands.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              Nothing is running. A web server or watch build started by an agent would appear
              here.
            </p>
          ) : (
            commands.map((c) => (
              <div key={c.pid} className="border-b p-3 last:border-b-0">
                <div className="flex items-start gap-2">
                  <TerminalSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="break-all font-mono text-xs">{c.command}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      pid {c.pid} · started {relative(c.startedAt)} · in {c.cwd}
                    </p>
                    {/* The first thing a server prints is usually the answer to
                        "is it actually up, and on what port" — which is what
                        anyone opening this list came to find out. */}
                    {c.output?.trim() && (
                      <pre className="mt-1.5 max-h-24 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed">
                        {c.output.trim()}
                      </pre>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 gap-1 px-2 text-xs"
                    onClick={async () => {
                      setError("");
                      try {
                        await stopCommand(c.pid);
                      } catch (err) {
                        setError(String(err.message ?? err));
                      }
                      refresh();
                    }}
                  >
                    <Square className="size-3" /> Stop
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {commands.length > 1 && (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={async () => {
              await stopAllCommands().catch((err) => setError(String(err.message ?? err)));
              refresh();
            }}
          >
            Stop all
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

function relative(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
