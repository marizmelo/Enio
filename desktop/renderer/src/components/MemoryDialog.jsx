import { useCallback, useEffect, useMemo, useState } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import { Pin, PinOff, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { TipButton } from "@/components/TipButton";
import { computePackedLayout } from "@/lib/forceLayout";
import {
  fetchMemory,
  fetchMemoryGraph,
  forgetFact,
  forgetPreference,
  forgetSummary,
  pinFact,
} from "@/lib/memory";

/**
 * What Enio knows about you, and the knife to trim it with.
 *
 * This surface exists because memory was writable everywhere and readable
 * nowhere: facts arrived from chat and the CLI, summaries from background
 * indexing, and the only view of any of it was a separate inspector server.
 * A thing that speaks up in every turn's prompt has to be auditable where
 * the turns happen.
 *
 * Summaries forget the *summary*, never the transcript — the History
 * dialog owns conversations. The distinction is the layer rule: the thread
 * is the task, memory is background about you, files are evidence.
 */
const ENTITY_COLORS = {
  person: "#3b82f6",
  project: "#10b981",
  technology: "#d97706",
  organization: "#8b5cf6",
  place: "#ef4444",
  concept: "#0891b2",
};

const when = (ts) =>
  new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function MemoryDialog({ open, onOpenChange }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("knows");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setData(await fetchMemory());
      setError("");
    } catch (err) {
      setError(String(err?.message ?? err));
    }
  }, []);

  useEffect(() => {
    if (open) {
      setTab("knows");
      refresh();
    }
  }, [open, refresh]);

  const act = (fn) => async () => {
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(String(err?.message ?? err));
    }
  };

  const facts = data?.facts ?? [];
  const preferences = data?.preferences ?? [];
  const summaries = data?.summaries ?? [];
  const empty = facts.length + preferences.length + summaries.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] w-[80vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <header className="flex shrink-0 items-center gap-4 border-b px-4 py-3">
          <DialogTitle className="text-sm font-medium">Memory</DialogTitle>
          <nav className="flex gap-1 text-xs">
            {[
              ["knows", "What it knows"],
              ["graph", "Graph"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`rounded px-2.5 py-1 ${
                  tab === id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          {error && <span className="truncate text-xs text-destructive">{error}</span>}
        </header>

        {tab === "knows" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {empty && data && (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Nothing yet. Say “remember that…” in chat, or set a preference —
                what Enio keeps shows up here.
              </p>
            )}

            {facts.length > 0 && (
              <section>
                <h3 className="text-xs font-medium text-muted-foreground">Facts</h3>
                <p className="mt-0.5 text-xs text-muted-foreground/70">
                  Injected into every turn that looks related. Pinned facts always ride along.
                </p>
                <ul className="mt-2 space-y-1">
                  {facts.map((f) => (
                    <li key={f.id} className="group flex items-start gap-2 rounded border px-2.5 py-1.5 text-sm">
                      <span className="min-w-0 flex-1">{f.text}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{f.source}</span>
                      <TipButton
                        tip={f.pinned ? "Unpin" : "Pin — always in context"}
                        className="size-6 shrink-0"
                        onClick={act(() => pinFact(f.id, !f.pinned))}
                      >
                        {f.pinned ? <Pin className="size-3 fill-current" /> : <PinOff className="size-3 opacity-50" />}
                      </TipButton>
                      <TipButton tip="Forget" className="size-6 shrink-0" onClick={act(() => forgetFact(f.id))}>
                        <Trash2 className="size-3" />
                      </TipButton>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {preferences.length > 0 && (
              <section className="mt-4">
                <h3 className="text-xs font-medium text-muted-foreground">Preferences</h3>
                <p className="mt-0.5 text-xs text-muted-foreground/70">
                  Standing instructions, in every single turn.
                </p>
                <ul className="mt-2 space-y-1">
                  {preferences.map((p) => (
                    <li key={p.id} className="flex items-start gap-2 rounded border px-2.5 py-1.5 text-sm">
                      <span className="min-w-0 flex-1">{p.text}</span>
                      <TipButton tip="Remove" className="size-6 shrink-0" onClick={act(() => forgetPreference(p.id))}>
                        <Trash2 className="size-3" />
                      </TipButton>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {summaries.length > 0 && (
              <section className="mt-4">
                <h3 className="text-xs font-medium text-muted-foreground">Conversation summaries</h3>
                <p className="mt-0.5 text-xs text-muted-foreground/70">
                  What past conversations contribute to new ones. Forgetting one removes it
                  from context but keeps the conversation — that lives in History.
                  A full <span className="font-mono">enio reindex</span> re-derives them all.
                </p>
                <ul className="mt-2 space-y-1">
                  {summaries.map((s) => (
                    <li key={s.sessionId} className="flex items-start gap-2 rounded border px-2.5 py-1.5 text-sm">
                      <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                        {when(s.startedAt)}
                      </span>
                      <span className="line-clamp-2 min-w-0 flex-1 text-xs leading-relaxed">{s.summary}</span>
                      <TipButton
                        tip="Forget this summary (keeps the conversation)"
                        className="size-6 shrink-0"
                        onClick={act(() => forgetSummary(s.sessionId))}
                      >
                        <Trash2 className="size-3" />
                      </TipButton>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        ) : (
          <MemoryGraph open={open && tab === "graph"} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The knowledge graph, drawn rather than queried.
 *
 * Same stack as the pipeline composer (ReactFlow) and the inspector's own
 * graph (the dependency-free force layout) — no new library for a view.
 * Layout is computed once per dataset; ReactFlow provides pan and zoom.
 */
function MemoryGraph({ open }) {
  const [raw, setRaw] = useState(null);

  useEffect(() => {
    if (open && !raw) fetchMemoryGraph().then(setRaw).catch(() => setRaw({ nodes: [], edges: [] }));
  }, [open, raw]);

  const flow = useMemo(() => {
    if (!raw) return { nodes: [], edges: [], hidden: 0 };
    // Entities with no surviving edges scatter to the margins and drag
    // fitView out until nothing is readable. The RELATIONS are what a graph
    // view is for, so isolated nodes are left out and counted in a footer —
    // unless everything is isolated, where hiding all beats explaining why.
    const connected = new Set();
    for (const e of raw.edges) {
      connected.add(e.source);
      connected.add(e.target);
    }
    const drawn =
      connected.size > 0 ? raw.nodes.filter((n) => connected.has(n.id)) : raw.nodes;
    const positions = computePackedLayout(drawn, raw.edges, { iterations: 250 });
    // The layout's natural spread suits the inspector's full window; in a
    // dialog pane fitView would zoom labels below legibility. Compressing
    // positions instead of raising minZoom keeps relative structure intact.
    const SCALE = 0.45;
    return {
      hidden: raw.nodes.length - drawn.length,
      nodes: drawn.map((n) => {
        const color = ENTITY_COLORS[String(n.type).toLowerCase()] ?? "#64748b";
        const p = positions.get(n.id) ?? { x: 0, y: 0 };
        return {
          id: String(n.id),
          position: { x: p.x * SCALE, y: p.y * SCALE },
          data: { label: n.name },
          style: {
            borderColor: color,
            borderWidth: 2,
            borderRadius: 8,
            // Mentions scale presence, gently: a name heard ten times reads
            // bigger than one heard once, without shouting. Via font size,
            // never transform — ReactFlow positions nodes WITH transform,
            // and overriding it stacks every node at the origin.
            fontSize: Math.round(Math.min(15, 10 + Math.log10(1 + (n.mentions ?? 1)) * 4)),
            padding: "4px 8px",
            width: "auto",
          },
        };
      }),
      edges: raw.edges.map((e) => ({
        id: String(e.id),
        source: String(e.source),
        target: String(e.target),
        label: e.relation.toLowerCase().replace(/_/g, " "),
        labelStyle: { fontSize: 9, fill: "var(--muted-foreground, #6b7280)" },
        style: { opacity: Math.max(0.35, e.confidence ?? 0.5) },
      })),
    };
  }, [raw]);

  if (raw && raw.nodes.length === 0) {
    return (
      <p className="flex flex-1 items-center justify-center px-10 text-center text-sm text-muted-foreground">
        The graph is empty. It fills in as conversations are indexed — the people,
        projects and tools Enio hears about, and how they relate.
      </p>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        fitView
        fitViewOptions={{ maxZoom: 1.1, padding: 0.15 }}
        minZoom={0.1}
        nodesConnectable={false}
        edgesFocusable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {flow.hidden > 0 && (
        <p className="absolute right-3 bottom-2 text-[11px] text-muted-foreground">
          + {flow.hidden} entit{flow.hidden === 1 ? "y" : "ies"} with no relations yet
        </p>
      )}
    </div>
  );
}
