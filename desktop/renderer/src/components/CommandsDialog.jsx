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
 * Grouped by the conversation that started it, because three anonymous
 * servers and three pids is not an answer to "what is this and why is it
 * here". The conversation is the thing a person remembers; the pid is not.
 *
 * Polled while open rather than pushed: these start and die outside any
 * stream, and a list that quietly went stale would be worse than no list.
 */
export function CommandsDialog({ open, onOpenChange, onChanged }) {
  const [commands, setCommands] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await listCommands();
      setCommands(list);
      onChanged?.(list.length);
      // A pid that has since exited must not stay selected: "stop selected"
      // would then report a failure for something already gone.
      setSelected((prev) => new Set([...prev].filter((pid) => list.some((c) => c.pid === pid))));
    } catch (err) {
      setError(String(err.message ?? err));
    }
  }, [onChanged]);

  useEffect(() => {
    if (!open) return;
    setError("");
    setSelected(new Set());
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  const toggle = (pid) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });

  const stopMany = async (pids) => {
    setBusy(true);
    setError("");
    // Stopped one at a time over the same endpoint a single Stop uses, and
    // failures are collected rather than thrown: a partial result has to be
    // reportable, or the list silently disagrees with what is running.
    const failed = [];
    for (const pid of pids) {
      try {
        await stopCommand(pid);
      } catch {
        failed.push(pid);
      }
    }
    setBusy(false);
    if (failed.length > 0) {
      setError(
        `Could not stop ${failed.length === 1 ? "pid " + failed[0] : failed.length + " of them"} — ` +
          "it may have already exited.",
      );
    }
    await refresh();
  };

  const groups = groupByConversation(commands);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] flex-col gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Running processes</DialogTitle>
          <DialogDescription>
            Everything an agent started and left running, grouped by the conversation it came
            from. They stop when you quit Enio, or whenever you say so here.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
          {commands.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              Nothing is running. A web server or watch build started by an agent would appear
              here.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.key}>
                <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1">
                  <p className="min-w-0 truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {group.title}
                  </p>
                  {groups.length > 1 && (
                    <button
                      className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground"
                      onClick={() => stopMany(group.commands.map((c) => c.pid))}
                      disabled={busy}
                    >
                      stop these
                    </button>
                  )}
                </div>
                {group.commands.map((c) => (
                  <div key={c.pid} className="border-b p-3 last:border-b-0">
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1 size-3.5 shrink-0 cursor-pointer"
                        checked={selected.has(c.pid)}
                        onChange={() => toggle(c.pid)}
                        aria-label={`Select pid ${c.pid}`}
                      />
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
                        disabled={busy}
                        onClick={() => stopMany([c.pid])}
                      >
                        <Square className="size-3" /> Stop
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {commands.length > 0 && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || selected.size === 0}
              onClick={() => stopMany([...selected])}
            >
              Stop selected{selected.size > 0 ? ` (${selected.size})` : ""}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                await stopAllCommands().catch((err) => setError(String(err.message ?? err)));
                setBusy(false);
                await refresh();
              }}
            >
              Stop all
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {commands.length} running
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * By conversation, newest command first within each.
 *
 * Anything with no conversation behind it — started before a chat was pinned,
 * or by a scheduled task — groups under a plain heading rather than being
 * hidden: an unattributed process is still one you may want to stop.
 */
function groupByConversation(commands) {
  const groups = new Map();
  for (const c of commands) {
    const key = c.sessionId || "unattributed";
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: c.conversation || "Not from a conversation",
        commands: [],
      });
    }
    groups.get(key).commands.push(c);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    commands: [...g.commands].sort((a, b) => b.startedAt - a.startedAt),
  }));
}

function relative(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
