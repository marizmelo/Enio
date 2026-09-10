import { useCallback, useEffect, useMemo, useState } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import { Pin, PinOff, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { fetchPersonality, setCuriosity, setPersonality } from "@/lib/personality";
import { TipButton } from "@/components/TipButton";
import { computePackedLayout } from "@/lib/forceLayout";
import {
  fetchMemory,
  fetchMemoryGraph,
  forgetFact,
  forgetGap,
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
  const gaps = data?.gaps ?? [];
  const empty = facts.length + preferences.length + summaries.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] w-[80vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <header className="flex shrink-0 items-center gap-4 border-b px-4 py-3">
          <DialogTitle className="text-sm font-medium">Memory</DialogTitle>
          <nav className="flex gap-1 text-xs">
            {[
              ["knows", "What it knows"],
              ["gaps", "What it lacked"],
              ["behavior", "Behavior"],
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
                    <li
                      key={f.id}
                      className={`group flex items-start gap-2 rounded border px-2.5 py-1.5 text-sm${
                        // Closed by a later fact: shown, dimmed. Hidden would
                        // be a memory that silently rewrites its own history.
                        f.supersededAt ? " opacity-50" : ""
                      }`}
                    >
                      <span className={`min-w-0 flex-1${f.supersededAt ? " line-through" : ""}`}>{f.text}</span>
                      {f.recalled > 0 && (
                        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums" title="Turns this fact was put in front of the model">
                          ×{f.recalled}
                        </span>
                      )}
                      <span
                        className="shrink-0 text-[10px] text-muted-foreground"
                        title={f.origin || undefined}
                      >
                        {f.supersededAt
                          ? "superseded"
                          : f.origin
                            ? f.origin.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]
                            : f.source}
                      </span>
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
        ) : tab === "behavior" ? (
          <BehaviorTab open={open && tab === "behavior"} onError={setError} />
        ) : tab === "gaps" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {/* The gap ledger: questions the turn answered from nothing —
                no memory, no file, no search. Derived from the traces, so
                forgetting one is until the next reindex, like a summary. */}
            {data && gaps.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Nothing yet. Questions Enio had to answer without anything in memory,
                files or the web behind it show up here.
              </p>
            )}
            {gaps.length > 0 && (
              <section>
                <h3 className="text-xs font-medium text-muted-foreground">Asked, and nothing covered it</h3>
                <p className="mt-0.5 text-xs text-muted-foreground/70">
                  Most asked first. A gap closes on its own once a remembered fact carries its words;
                  closed ones stay, dimmed, so you can see what it learned later.
                </p>
                <ul className="mt-2 space-y-1">
                  {gaps.map((g) => (
                    <li
                      key={g.id}
                      className={`flex items-start gap-2 rounded border px-2.5 py-1.5 text-sm${
                        g.resolvedBy ? " opacity-50" : ""
                      }`}
                    >
                      <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                        {when(g.lastAt)}
                      </span>
                      <span className="min-w-0 flex-1">{g.question}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                        {g.resolvedBy ? "learned" : g.count > 1 ? `×${g.count}` : ""}
                      </span>
                      <TipButton tip="Forget (comes back on reindex)" className="size-6 shrink-0" onClick={act(() => forgetGap(g.id))}>
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

const AXIS_LABELS = { voice: "Length", warmth: "Warmth", initiative: "Initiative", register: "Register" };
const levelLabel = (l) => l.replace(/-/g, " ");

/**
 * How Enio replies: four axes with three levels, derived from what memory
 * holds unless set here. The block at the bottom is the exact text the
 * next turn carries — the same function the turn calls, never a trace —
 * so "why does it still answer briefly" has an answer on this screen:
 * a level marked auto says what it came from, and a choice that a
 * standing preference argues with is listed as a conflict.
 */
function BehaviorTab({ open, onError }) {
  const [view, setView] = useState(null);
  const load = useCallback(async () => {
    try {
      setView(await fetchPersonality());
      onError("");
    } catch (err) {
      onError(String(err?.message ?? err));
    }
  }, [onError]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const choose = (axis, level) => async () => {
    try {
      setView(await setPersonality(axis, level));
    } catch (err) {
      onError(String(err?.message ?? err));
    }
  };
  const curiosity = (value) => async () => {
    try {
      setView(await setCuriosity(value));
    } catch (err) {
      onError(String(err?.message ?? err));
    }
  };
  if (!view) return null;

  const because = (axis) => {
    const s = view.sources[axis];
    if (s === "explicit") return "set here";
    if (s === "none") return "no signal in memory";
    if (s.startsWith("preference:")) return `from preference #${s.split(":")[1]}`;
    if (s.startsWith("exemplars:")) return `from ${s.split(":")[1]} good answers`;
    if (s.startsWith("graph:")) return "from what memory says you work with";
    return s;
  };
  const AXES = { voice: ["terse", "plain", "conversational"], warmth: ["matter-of-fact", "friendly", "warm"], initiative: ["answer-only", "suggest-next-step", "offer-follow-ups"], register: ["everyday", "technical", "expert"] };
  const segment = (active) =>
    `rounded px-2 py-0.5 text-xs ${active ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"}`;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <p className="text-xs text-muted-foreground/70">
        Derived from your preferences, the answers you marked good, and what memory says you
        work with. Set an axis to override; auto restores the derived level.
      </p>
      <ul className="mt-3 space-y-2">
        {Object.entries(AXES).map(([axis, levels]) => (
          <li key={axis} className="flex flex-wrap items-center gap-2 rounded border px-2.5 py-1.5 text-sm">
            <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">{AXIS_LABELS[axis]}</span>
            <span className="flex gap-1">
              {levels.map((l) => (
                <button key={l} type="button" className={segment(view.effective[axis] === l)} onClick={choose(axis, l)}>
                  {levelLabel(l)}
                </button>
              ))}
              <button type="button" className={segment(view.levels[axis] === "auto")} onClick={choose(axis, "auto")}>
                auto
              </button>
            </span>
            {view.levels[axis] === "auto" && <Badge variant="outline">auto</Badge>}
            <span className="text-xs text-muted-foreground">
              {because(axis)}
              {view.unrendered.includes(axis) ? " · no prompt line for this level (it changed what the model did when measured)" : ""}
            </span>
          </li>
        ))}
        <li className="flex flex-wrap items-center gap-2 rounded border px-2.5 py-1.5 text-sm">
          <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">Curiosity</span>
          <span className="flex gap-1">
            <button type="button" className={segment(view.curiosity === "quiet")} onClick={curiosity("quiet")}>quiet</button>
            <button type="button" className={segment(view.curiosity === "flag")} onClick={curiosity("flag")}>flag gaps</button>
          </span>
          <span className="text-xs text-muted-foreground">
            {view.curiosity === "flag" ? "says so when a question lands in What it lacked" : "a switch on the app, never a line in the prompt"}
          </span>
        </li>
      </ul>
      {view.conflicts.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          A standing preference argues with a choice above: {view.conflicts.map((c) => `“${c}”`).join(", ")}.
          The preference is in the prompt too; remove it under What it knows if the choice should win.
        </p>
      )}
      <h3 className="mt-4 text-xs font-medium text-muted-foreground">What the next turn carries</h3>
      <pre className="mt-1 rounded border bg-muted/40 px-2.5 py-2 text-xs whitespace-pre-wrap">
        {view.block || "(nothing: every axis is neutral, or its level is already a preference in the prompt)"}
      </pre>
    </div>
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
