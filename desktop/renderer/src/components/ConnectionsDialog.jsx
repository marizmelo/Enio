import { useCallback, useEffect, useState } from "react";
import { Loader2, Plug, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  addMcpServer,
  listMcpServers,
  removeMcpServer,
  setMcpServerDisabled,
} from "@/lib/mcp";
import { AccountsPanel } from "@/components/AccountsPanel";

/**
 * MCP connections: the same ~/.enio/mcp.json the CLI edits, with the reload
 * built in — every change reconnects immediately, no restart.
 *
 * Status is honest by construction: the server reports what the last load
 * actually achieved, so a connection that failed shows its error string
 * where a lesser dialog would show a hopeful spinner.
 */
export function ConnectionsDialog({ open, onOpenChange, onChanged }) {
  const [servers, setServers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [tools, setTools] = useState("");

  const refresh = useCallback(() => {
    listMcpServers().then(setServers).catch(() => setServers([]));
  }, []);

  useEffect(() => {
    if (open) {
      refresh();
      setError("");
      setAdding(false);
    }
  }, [open, refresh]);

  /** Runs a mutation that returns the new list; connection changes also
   *  change what the agent can do, so the app refetches capabilities. */
  const apply = async (fn) => {
    setBusy(true);
    setError("");
    try {
      setServers(await fn());
      onChanged?.();
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    apply(async () => {
      // The command line is one string in the form; the first word is the
      // executable, the rest are its arguments.
      const words = command.trim().split(/\s+/);
      const allow = tools.trim() ? tools.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
      const next = await addMcpServer({
        name: name.trim(),
        command: words[0],
        args: words.slice(1),
        tools: allow,
      });
      setAdding(false);
      setName("");
      setCommand("");
      setTools("");
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-3 sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>Connections</DialogTitle>
          <DialogDescription>
            Accounts and MCP servers — what Enio can reach beyond this machine. Changes take
            effect immediately, with no restart.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="shrink-0 text-xs text-destructive">{error}</p>}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <section className="space-y-2">
            <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Google accounts
            </h3>
            <AccountsPanel onError={setError} />
          </section>

          <section className="space-y-2">
            <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              MCP servers
            </h3>
        <div className="rounded-md border">
          {servers.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              No connections yet. Add one below — it becomes tools the agent can use.
            </p>
          ) : (
            servers.map((s) => (
              <div key={s.name} className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
                <span
                  className={`size-2 shrink-0 rounded-full ${
                    s.disabled ? "bg-muted-foreground/40" : s.connected ? "bg-emerald-500" : "bg-destructive"
                  }`}
                  title={s.disabled ? "Disabled" : s.connected ? "Connected" : "Not connected"}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {s.name}
                    {s.connected && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {s.toolCount} tool{s.toolCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {s.command} {(s.args ?? []).join(" ")}
                  </p>
                  {/* The failure itself, verbatim — an honest error beats a
                      hopeful dot. */}
                  {!s.disabled && !s.connected && s.error && (
                    <p className="text-[11px] text-destructive">{s.error}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => apply(() => setMcpServerDisabled(s.name, !s.disabled))}
                >
                  {s.disabled ? "Enable" : "Disable"}
                </Button>
                <button
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  title="Remove connection"
                  disabled={busy}
                  onClick={() => apply(() => removeMcpServer(s.name))}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        {adding ? (
          <div className="flex flex-col gap-1.5 rounded-md border p-2.5">
            <input
              autoFocus
              className="rounded-md border bg-transparent px-2 py-1 text-xs"
              placeholder="Name — e.g. home-assistant"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
              placeholder="Command — e.g. npx -y @modelcontextprotocol/server-filesystem ~/notes"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
            <input
              className="rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
              placeholder="Allowed tools, comma-separated (recommended)"
              value={tools}
              onChange={(e) => setTools(e.target.value)}
            />
            <p className="text-[10px] leading-tight text-muted-foreground">
              A typical server exposes 10–30 tools, which overwhelms a small model. Listing the
              few you want is the difference between this working and not.
            </p>
            <div className="flex gap-1.5">
              <Button size="sm" disabled={busy || !name.trim() || !command.trim()} onClick={add}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                Connect
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" className="gap-1 self-start" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> Add connection
          </Button>
        )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
