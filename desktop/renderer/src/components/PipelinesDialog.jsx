import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
} from "@xyflow/react";
import {
  AppWindow,
  Brain,
  Camera,
  ChevronRight,
  Code,
  FilePen,
  FileSearch,
  Globe,
  Inbox,
  Loader2,
  Play,
  Plus,
  Send,
  ShoppingCart,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  composePipeline,
  deletePipeline,
  getPipeline,
  listPipelines,
  runPipeline,
  saveAsExample,
  savePipeline,
} from "@/lib/pipelines";

const ICONS = {
  globe: Globe,
  "file-search": FileSearch,
  "file-pen": FilePen,
  code: Code,
  inbox: Inbox,
  send: Send,
  "app-window": AppWindow,
  camera: Camera,
  brain: Brain,
  "shopping-cart": ShoppingCart,
};

const STATUS_RING = {
  running: "ring-2 ring-amber-400 animate-pulse",
  finished: "ring-2 ring-emerald-500",
  failed: "ring-2 ring-destructive",
  skipped: "opacity-40",
};

/**
 * One ability as a canvas node: icon, title, status ring while running, and
 * the first line of its guidance. Ports are untyped visually — the wiring
 * rule (outputs ∩ inputs ≠ ∅) is enforced on connect and again server-side.
 */
function AbilityNode({ data, selected }) {
  const Icon = ICONS[data.icon] ?? Sparkles;
  return (
    <div
      className={`w-44 rounded-lg border bg-background px-3 py-2 text-left shadow-sm ${
        STATUS_RING[data.status] ?? ""
      } ${selected ? "border-foreground/40" : ""}`}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <div className="flex items-center gap-1.5">
        {data.status === "running" ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <Icon className="size-3.5 shrink-0" />
        )}
        <span className="truncate text-xs font-medium">{data.title}</span>
      </div>
      <p className="mt-1 line-clamp-2 text-[10px] leading-tight text-muted-foreground">
        {data.prompt}
      </p>
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
    </div>
  );
}

const nodeTypes = { ability: AbilityNode };

/** Column-per-topological-rank layout for composed graphs; no layout dep. */
function layout(nodes, edges) {
  const rank = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    for (const e of edges) {
      rank.set(e.to, Math.max(rank.get(e.to) ?? 0, (rank.get(e.from) ?? 0) + 1));
    }
  }
  const perRank = new Map();
  return nodes.map((n) => {
    const r = rank.get(n.id) ?? 0;
    const row = perRank.get(r) ?? 0;
    perRank.set(r, row + 1);
    return { ...n, position: n.position ?? { x: 40 + r * 230, y: 40 + row * 120 } };
  });
}

export function PipelinesDialog({ open, onOpenChange, abilities = [] }) {
  const [saved, setSaved] = useState([]);
  const [view, setView] = useState("list"); // list | canvas
  const [current, setCurrent] = useState(null); // {id?, name}
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [finale, setFinale] = useState("");
  const counter = useRef(0);

  const byId = useMemo(() => new Map(abilities.map((a) => [a.id, a])), [abilities]);
  const composable = abilities.filter((a) => a.availability === "available" && a.id !== "chat");

  const refresh = useCallback(() => {
    listPipelines().then(setSaved).catch(() => setSaved([]));
  }, []);

  useEffect(() => {
    if (open) {
      refresh();
      setView("list");
      setError("");
      setFinale("");
    }
  }, [open, refresh]);

  /** Server graph → React Flow state. The ability's title/icon ride in
   *  node.data so the canvas needs no lookups while dragging. */
  const toFlow = useCallback(
    (pipelineNodes, pipelineEdges) => {
      const flowNodes = layout(
        pipelineNodes.map((n) => ({
          id: n.id,
          type: "ability",
          position: n.position,
          data: {
            abilityId: n.abilityId,
            title: byId.get(n.abilityId)?.title ?? n.abilityId,
            icon: byId.get(n.abilityId)?.icon,
            prompt: n.prompt,
            status: null,
          },
        })),
        pipelineEdges,
      );
      setNodes(flowNodes);
      setEdges(pipelineEdges.map((e) => ({ id: `${e.from}-${e.to}`, source: e.from, target: e.to })));
    },
    [byId],
  );

  const fromFlow = useCallback(
    () => ({
      nodes: nodes.map((n) => ({
        id: n.id,
        abilityId: n.data.abilityId,
        prompt: n.data.prompt,
        position: n.position,
      })),
      edges: edges.map((e) => ({ from: e.source, to: e.target })),
    }),
    [nodes, edges],
  );

  const compose = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    setError("");
    try {
      const draft = await composePipeline(prompt);
      if (!draft.ok) throw new Error(draft.reason);
      toFlow(
        draft.nodes.map((n) => ({ ...n, position: undefined })),
        draft.edges,
      );
      setCurrent((c) => c ?? { name: "" });
      setView("canvas");
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  /** The wiring rule, enforced at the moment of connection so an impossible
   *  chain cannot even be drawn — the same rule the server re-checks. */
  const isValidConnection = useCallback(
    (conn) => {
      const from = byId.get(nodes.find((n) => n.id === conn.source)?.data.abilityId);
      const to = byId.get(nodes.find((n) => n.id === conn.target)?.data.abilityId);
      if (!from || !to) return false;
      return from.outputs.some((p) => to.inputs.includes(p));
    },
    [nodes, byId],
  );

  const addAbilityNode = (ability) => {
    counter.current += 1;
    const id = `n${Date.now().toString(36)}${counter.current}`;
    setNodes((ns) => [
      ...ns,
      {
        id,
        type: "ability",
        position: { x: 60 + ns.length * 40, y: 60 + ns.length * 40 },
        data: {
          abilityId: ability.id,
          title: ability.title,
          icon: ability.icon,
          prompt: ability.promptTemplate.replace("___", "").trim(),
          status: null,
        },
      },
    ]);
  };

  const persist = async () => {
    const name = current?.name?.trim() || window.prompt("Name this pipeline:");
    if (!name) return null;
    setBusy(true);
    setError("");
    try {
      const graph = fromFlow();
      const pipeline = await savePipeline({ id: current?.id, name, ...graph });
      setCurrent({ id: pipeline.id, name: pipeline.name });
      refresh();
      return pipeline;
    } catch (err) {
      setError(String(err?.message ?? err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    const pipeline = await persist();
    if (!pipeline) return;
    setRunning(true);
    setFinale("");
    setError("");
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: null } })));
    try {
      await runPipeline(pipeline.id, (event) => {
        if (event.nodeId) {
          const status =
            event.type === "node_started"
              ? "running"
              : event.type === "node_finished"
                ? "finished"
                : event.type === "node_failed"
                  ? "failed"
                  : event.type === "node_skipped"
                    ? "skipped"
                    : null;
          if (status) {
            setNodes((ns) =>
              ns.map((n) => (n.id === event.nodeId ? { ...n, data: { ...n.data, status } } : n)),
            );
          }
          if (event.type === "node_failed") setError(event.error);
        }
        if (event.type === "run_finished") {
          setFinale(event.status === "succeeded" ? "Done — every step finished." : "Stopped — a step failed.");
        }
      });
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setRunning(false);
      refresh();
    }
  };

  const openSaved = async (summary) => {
    try {
      const pipeline = await getPipeline(summary.id);
      setCurrent({ id: pipeline.id, name: pipeline.name });
      toFlow(pipeline.nodes, pipeline.edges);
      setSelectedNode(null);
      setFinale("");
      setError("");
      setView("canvas");
    } catch (err) {
      setError(String(err?.message ?? err));
    }
  };

  const selected = selectedNode ? nodes.find((n) => n.id === selectedNode) : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !running && onOpenChange(next)}>
      <DialogContent className="flex h-[85vh] max-w-none flex-col gap-3 sm:max-w-4xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>Pipelines</DialogTitle>
          <DialogDescription>
            Chain abilities into one flow. Each step runs as its own narrow turn — the graph is
            yours, and nothing runs until you press run.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="shrink-0 text-xs text-destructive">{error}</p>}
        {finale && <p className="shrink-0 text-xs text-muted-foreground">{finale}</p>}

        {view === "list" ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                compose();
              }}
            >
              <input
                autoFocus
                className="min-w-0 flex-1 rounded-md border bg-transparent px-3 py-2 text-sm"
                placeholder="Describe a flow — e.g. research a topic and write a document about it"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <Button type="submit" disabled={busy || !prompt.trim()} className="gap-1">
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
                Compose
              </Button>
            </form>

            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
              {saved.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">
                  No saved pipelines yet. Describe one above, or start from a blank canvas.
                </p>
              ) : (
                saved.map((p) => (
                  <div
                    key={p.id}
                    className="flex w-full items-center gap-2 border-b px-3 py-2 last:border-b-0 hover:bg-muted"
                  >
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => openSaved(p)}
                    >
                      <ChevronRight className="size-3 shrink-0" />
                      <span className="text-sm">{p.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {p.nodeCount} step{p.nodeCount === 1 ? "" : "s"}
                      </span>
                    </button>
                    <button
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      title="Delete pipeline"
                      onClick={async () => {
                        await deletePipeline(p.id).catch(() => {});
                        refresh();
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>

            <Button
              variant="outline"
              size="sm"
              className="gap-1 self-start"
              onClick={() => {
                setCurrent({ name: "" });
                setNodes([]);
                setEdges([]);
                setSelectedNode(null);
                setView("canvas");
              }}
            >
              <Plus className="size-3.5" /> Blank canvas
            </Button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-2">
            {/* Palette: only available abilities — a step that cannot run has
                no business on the canvas. */}
            <div className="flex w-40 shrink-0 flex-col gap-1 overflow-y-auto">
              <button
                className="mb-1 self-start text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  if (!running) {
                    setView("list");
                    refresh();
                  }
                }}
              >
                ← All pipelines
              </button>
              {composable.map((a) => {
                const Icon = ICONS[a.icon] ?? Sparkles;
                return (
                  <button
                    key={a.id}
                    disabled={running}
                    title={a.description}
                    onClick={() => addAbilityNode(a)}
                    className="flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-xs hover:bg-muted"
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">{a.title}</span>
                    <Plus className="ml-auto size-3 shrink-0 text-muted-foreground" />
                  </button>
                );
              })}
            </div>

            <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={(changes) => !running && setNodes((ns) => applyNodeChanges(changes, ns))}
                onEdgesChange={(changes) => !running && setEdges((es) => applyEdgeChanges(changes, es))}
                onConnect={(conn) => !running && setEdges((es) => addEdge(conn, es))}
                isValidConnection={isValidConnection}
                onNodeClick={(_e, node) => setSelectedNode(node.id)}
                onPaneClick={() => setSelectedNode(null)}
                fitView
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={16} />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>

            <div className="flex w-56 shrink-0 flex-col gap-2">
              {selected ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">{selected.data.title}</span>
                    <button
                      className="text-muted-foreground hover:text-destructive"
                      title="Remove step"
                      disabled={running}
                      onClick={() => {
                        setNodes((ns) => ns.filter((n) => n.id !== selected.id));
                        setEdges((es) =>
                          es.filter((e) => e.source !== selected.id && e.target !== selected.id),
                        );
                        setSelectedNode(null);
                      }}
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                  <Textarea
                    className="min-h-28 flex-1 text-xs"
                    value={selected.data.prompt}
                    disabled={running}
                    placeholder="What should this step do? Guidance in plain words — the agent keeps its own tools."
                    onChange={(e) =>
                      setNodes((ns) =>
                        ns.map((n) =>
                          n.id === selected.id
                            ? { ...n, data: { ...n.data, prompt: e.target.value } }
                            : n,
                        ),
                      )
                    }
                  />
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Click a step to edit its guidance. Drag between the dots to connect steps —
                  connections that make no sense are refused.
                </p>
              )}

              <div className="mt-auto flex flex-col gap-1.5">
                <Button size="sm" className="gap-1" disabled={busy || running || nodes.length === 0} onClick={run}>
                  {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                  {running ? "Running…" : "Run"}
                </Button>
                <Button size="sm" variant="outline" disabled={busy || running || nodes.length === 0} onClick={persist}>
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs text-muted-foreground"
                  disabled={busy || running || !current?.id}
                  title="Feed this pipeline to the composer as an example it can learn the shape of"
                  onClick={async () => {
                    const examplePrompt = window.prompt(
                      "What request should this pipeline be the example for?",
                      prompt,
                    );
                    if (examplePrompt) {
                      await saveAsExample(current.id, examplePrompt).catch((err) =>
                        setError(String(err?.message ?? err)),
                      );
                    }
                  }}
                >
                  Save as example
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
