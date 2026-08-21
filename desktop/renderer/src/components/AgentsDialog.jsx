import { useEffect, useState } from "react";
import { BookOpen, Plug, Workflow } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

const AGENT_BASE = "http://127.0.0.1:8787";

/**
 * The agents, managed by looking rather than by editing.
 *
 * Everything shown is derived live — the tools an agent holds RIGHT NOW
 * (a mail tool without an account simply is not there), the skills whose
 * allowed-tools it can actually act on, the automations with a step that
 * runs as it. There is nothing to configure on this panel by design: an
 * agent's tool set is an invariant (six, disjoint), not a preference, and a
 * panel that let it be edited would be a panel for breaking the one property
 * that makes a small model pick tools well.
 */
export function AgentsDialog({ open, onOpenChange }) {
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const token = await window.maple?.getToken();
        const res = await fetch(`${AGENT_BASE}/agents`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error?.message ?? `agents returned ${res.status}`);
        setAgents(body.agents ?? []);
        setError("");
      } catch (err) {
        setError(String(err.message ?? err));
      }
    })();
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] flex-col gap-3 sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>Agents</DialogTitle>
          <DialogDescription>
            Who answers what, and what each can reach right now. Memory is shared — every agent
            recalls the same facts. Routing picks the agent; @name in a message overrides it.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="shrink-0 text-xs text-destructive">{error}</p>}

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {agents.map((a) => (
            <div key={a.name} className="rounded-md border p-3">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-sm font-medium">@{a.name}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{a.description}</p>

              <div className="mt-2 flex flex-wrap gap-1">
                {a.tools.map((t) => (
                  <Badge
                    key={t.name}
                    variant="secondary"
                    className={`font-mono text-[10px] ${t.available ? "" : "opacity-40 line-through"}`}
                    title={t.description}
                  >
                    {t.name}
                  </Badge>
                ))}
                {a.mcpServers.map((m) => (
                  <Badge key={m} variant="outline" className="text-[10px]" title="MCP connection this agent may use when connected">
                    <Plug className="mr-1 size-2.5" />
                    {m}
                  </Badge>
                ))}
              </div>

              {(a.skills.length > 0 || a.automations.length > 0) && (
                <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                  {a.skills.length > 0 && (
                    <p className="flex flex-wrap items-center gap-1">
                      <BookOpen className="size-3" />
                      {a.skills.join(" · ")}
                    </p>
                  )}
                  {a.automations.length > 0 && (
                    <p className="flex flex-wrap items-center gap-1">
                      <Workflow className="size-3" />
                      {a.automations.join(" · ")}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <p className="shrink-0 text-[11px] text-muted-foreground">
          A crossed-out tool is withheld until its setup exists — an account, a flag, a config.
          Tool sets are fixed at six per agent on purpose; skills and automations are where
          behavior grows.
        </p>
      </DialogContent>
    </Dialog>
  );
}
