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
  ArrowUpRight,
  Brain,
  Camera,
  ChevronRight,
  Clock,
  Code,
  FilePen,
  FileSearch,
  Globe,
  History,
  Inbox,
  Loader2,
  PencilLine,
  Play,
  Plus,
  Send,
  ShoppingCart,
  Sparkles,
  Square,
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
  listRuns,
  runDraft,
  runPipeline,
  savePipeline,
  savePipelineAsSkill,
  stopPipeline,
  suggestPipelines,
} from "@/lib/pipelines";
import { clearSchedule, listTasks, setSchedule } from "@/lib/tasks";
import { DAY_NAMES, composeSchedule, describeSchedule, parseSchedule } from "@/lib/schedule";
import { SkillsPanel } from "@/components/SkillsPanel";

const ICONS = {
  "pencil-line": PencilLine,
  "arrow-up-right": ArrowUpRight,
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

function agoShort(ts) {
  if (!ts) return null;
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  return days < 30 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`;
}

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
  const [current, setCurrent] = useState(null); // {id?, name, vouched?}
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [prompt, setPrompt] = useState("");
  // Inline, not window.prompt(): Electron does not implement prompt(), and
  // the throw happened outside every catch — Save and Run silently did
  // nothing, which is the worst possible shape for a button.
  const [name, setName] = useState("");
  // The compose prompt rides along as the pipeline's description: it is what
  // lets a saved flow teach the composer once it has run successfully.
  const [composedFrom, setComposedFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [finale, setFinale] = useState("");
  // Run-before-save: a draft runs without a name, and only a canvas that has
  // actually executed can be saved — the same order recipes earn their keep.
  const [hasRun, setHasRun] = useState(false);
  // From run_started: which id to stop, and which run a save should adopt.
  const [stopTarget, setStopTarget] = useState(null);
  const [lastRunId, setLastRunId] = useState(null);
  // File paths the run produced, so "where did my document go" has an answer
  // on the same screen that made it.
  const [artifacts, setArtifacts] = useState([]);
  // null = not asked yet, [] = asked and nothing found — the empty answer is
  // still an answer and deserves its own line.
  const [drafts, setDrafts] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  // The list view's second face: the skills the flows sit beside.
  const [tab, setTab] = useState("automations");
  // pipelineId -> its auto-schedule task; user-named CLI tasks never land here.
  const [schedules, setSchedules] = useState({});
  const [schedulerRunning, setSchedulerRunning] = useState(true);
  // The inline schedule editor: repeat + time, never a cron field. Cron is
  // the storage format; composeSchedule writes it out of sight.
  const [editorFor, setEditorFor] = useState(null);
  const [editRepeat, setEditRepeat] = useState("daily");
  const [editTime, setEditTime] = useState("09:00");
  const [editDays, setEditDays] = useState([1]);
  const [editDom, setEditDom] = useState(1);
  // Two-click delete when a schedule exists — window.confirm is native, but
  // an in-place arm-then-fire keeps the warning on the row it is about.
  const [confirmDelete, setConfirmDelete] = useState(null);
  const counter = useRef(0);

  const byId = useMemo(() => new Map(abilities.map((a) => [a.id, a])), [abilities]);
  const composable = abilities.filter((a) => a.availability === "available" && a.id !== "chat");

  const refresh = useCallback(() => {
    listPipelines().then(setSaved).catch(() => setSaved([]));
    listTasks()
      .then((d) => {
        setSchedulerRunning(d.schedulerRunning !== false);
        const map = {};
        for (const t of d.tasks ?? []) {
          // isAutoSchedule is the server's claim check: a user's own
          // "auto-daily" CLI task must not surface as a chip here.
          if (t.isAutoSchedule) map[t.name.slice("auto-".length)] = t;
        }
        setSchedules(map);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (open) {
      refresh();
      setView("list");
      setTab("automations");
      setError("");
      setFinale("");
      setDrafts(null);
      setEditorFor(null);
      setConfirmDelete(null);
    }
  }, [open, refresh]);

  /** Opens the editor seeded from the existing schedule, or sane defaults. */
  const openScheduleEditor = (pipelineId, existingCron) => {
    const form = existingCron ? parseSchedule(existingCron) : null;
    setEditRepeat(form?.repeat ?? "daily");
    setEditTime(form?.time ?? "09:00");
    setEditDays(form?.days?.length ? form.days : [1]);
    setEditDom(form?.dayOfMonth ?? 1);
    setEditorFor((prior) => (prior === pipelineId ? null : pipelineId));
  };

  const saveSchedule = async (pipelineId) => {
    const cron = composeSchedule({
      repeat: editRepeat,
      time: editTime,
      days: editDays,
      dayOfMonth: editDom,
    });
    if (!cron) {
      setError("Pick at least one day.");
      return;
    }
    setError("");
    try {
      await setSchedule(pipelineId, cron);
      setEditorFor(null);
      refresh();
    } catch (err) {
      setError(String(err?.message ?? err));
    }
  };

  const unschedule = async (pipelineId) => {
    setError("");
    try {
      await clearSchedule(pipelineId);
      setEditorFor(null);
      refresh();
    } catch (err) {
      setError(String(err?.message ?? err));
    }
  };

  const toggleEditDay = (day) => {
    setEditDays((prior) =>
      prior.includes(day) ? prior.filter((d) => d !== day) : [...prior, day],
    );
  };

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
      setComposedFrom(prompt.trim());
      // A compose is always a fresh draft. Keeping stale editing state here
      // meant a compose after opening a saved pipeline silently overwrote
      // that pipeline on save, under its old name.
      setCurrent({ name: "" });
      setName("");
      setHasRun(false);
      setLastRunId(null);
      setArtifacts([]);
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
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the automation a name first.");
      return null;
    }
    setBusy(true);
    setError("");
    try {
      const graph = fromFlow();
      const pipeline = await savePipeline({
        id: current?.id,
        name: trimmed,
        ...(composedFrom ? { description: composedFrom } : {}),
        // Saving right after a watched draft run brings that run along, so
        // the pipeline arrives already vouched — no ritual second run.
        ...(!current?.id && lastRunId ? { adoptRunId: lastRunId } : {}),
        ...graph,
      });
      setCurrent({ id: pipeline.id, name: pipeline.name });
      setLastRunId(null);
      refresh();
      return pipeline;
    } catch (err) {
      setError(String(err?.message ?? err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const onRunEvent = (event) => {
    if (event.type === "run_started") {
      setStopTarget(event.pipelineId);
      setLastRunId(event.runId);
      return;
    }
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
      if (event.type === "node_finished") {
        const paths = (event.artifacts ?? []).map((a) => a.path).filter(Boolean);
        if (paths.length) setArtifacts((prior) => [...prior, ...paths]);
        setNodes((ns) =>
          ns.map((n) =>
            n.id === event.nodeId ? { ...n, data: { ...n.data, reply: event.reply } } : n,
          ),
        );
      }
      if (event.type === "node_failed") {
        setError(event.error);
        setNodes((ns) =>
          ns.map((n) =>
            n.id === event.nodeId ? { ...n, data: { ...n.data, reply: event.error } } : n,
          ),
        );
      }
    }
    if (event.type === "run_finished") {
      setHasRun(true);
      if (event.status === "succeeded") {
        setCurrent((c) => (c?.id ? { ...c, vouched: true } : c));
      }
      setFinale(
        event.status === "succeeded"
          ? "Done — every step finished."
          : event.status === "cancelled"
            ? "Stopped by you — nothing after the current step ran."
            : "Stopped — a step failed.",
      );
    }
  };

  /** A saved pipeline runs by id (persisting edits first); an unsaved canvas
   *  runs as a draft — proving a flow works comes BEFORE naming it. */
  const run = async () => {
    let pipelineId = current?.id;
    if (pipelineId) {
      const pipeline = await persist();
      if (!pipeline) return;
      pipelineId = pipeline.id;
    }
    setRunning(true);
    setFinale("");
    setError("");
    setArtifacts([]);
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: null } })));
    try {
      if (pipelineId) await runPipeline(pipelineId, onRunEvent);
      else await runDraft(fromFlow(), onRunEvent);
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setRunning(false);
      setStopTarget(null);
      refresh();
    }
  };

  const stop = async () => {
    if (!stopTarget) return;
    try {
      await stopPipeline(stopTarget);
    } catch (err) {
      setError(String(err?.message ?? err));
    }
  };

  const suggest = async () => {
    setSuggesting(true);
    setError("");
    try {
      setDrafts(await suggestPipelines());
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setSuggesting(false);
    }
  };

  /** A draft opens unsaved: naming and saving it is the user's act, and the
   *  save is also what makes it teachable once it runs successfully. */
  const openDraft = (draft) => {
    setCurrent({ name: "" });
    setName("");
    setHasRun(false);
    setLastRunId(null);
    setArtifacts([]);
    setComposedFrom(draft.title);
    toFlow(draft.nodes, draft.edges);
    setSelectedNode(null);
    setFinale("");
    setError("");
    setView("canvas");
  };

  const openSaved = async (summary) => {
    try {
      const pipeline = await getPipeline(summary.id);
      setCurrent({ id: pipeline.id, name: pipeline.name, vouched: summary.vouched === true });
      setName(pipeline.name);
      setComposedFrom(pipeline.description ?? "");
      setHasRun(false);
      setLastRunId(null);
      setArtifacts([]);
      toFlow(pipeline.nodes, pipeline.edges);
      setSelectedNode(null);
      setFinale("");
      setError("");
      setView("canvas");
      // The execution log: the latest run's statuses, replies and files are
      // laid over the canvas, so opening a pipeline answers "what did it do
      // last time" without re-running anything.
      try {
        const runs = await listRuns(pipeline.id);
        const last = runs?.[0];
        if (last?.nodeResults?.length) {
          setFinale(
            `Last run ${last.status} — ${new Date(last.startedAt).toLocaleString()}.`,
          );
          setNodes((ns) =>
            ns.map((n) => {
              const r = last.nodeResults.find((x) => x.nodeId === n.id);
              if (!r) return n;
              const status =
                r.status === "finished" ? "finished" : r.status === "failed" ? "failed" : "skipped";
              return { ...n, data: { ...n.data, status, reply: r.reply || r.error || "" } };
            }),
          );
          setArtifacts(
            last.nodeResults.flatMap((r) => (r.artifacts ?? []).map((a) => a.path).filter(Boolean)),
          );
        }
      } catch {
        /* no runs is not an error */
      }
    } catch (err) {
      setError(String(err?.message ?? err));
    }
  };

  const selected = selectedNode ? nodes.find((n) => n.id === selectedNode) : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !running && onOpenChange(next)}>
      <DialogContent className="flex h-[80vh] w-[80vw] max-w-none flex-col gap-3 sm:max-w-none">
        <DialogHeader className="shrink-0">
          <div className="flex items-center gap-3">
            <DialogTitle>{view === "list" && tab === "skills" ? "Skills" : "Automations"}</DialogTitle>
            {view === "list" && (
              <nav className="flex gap-1 text-xs">
                {[
                  ["automations", "Automations"],
                  ["skills", "Skills"],
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
            )}
          </div>
          <DialogDescription>
            {view === "list" && tab === "skills"
              ? "Know-how Enio can follow — markdown files you own. Type /name in chat to run one directly."
              : "Chain abilities into one flow. Each step runs as its own narrow turn — the graph is yours, and nothing runs until you press run."}
          </DialogDescription>
        </DialogHeader>

        {error && <p className="shrink-0 text-xs text-destructive">{error}</p>}
        {finale && <p className="shrink-0 text-xs text-muted-foreground">{finale}</p>}
        {artifacts.length > 0 && (
          <div className="shrink-0 text-[11px] text-muted-foreground">
            Files this run produced:
            {artifacts.map((p) => (
              <code key={p} className="ml-1.5 rounded bg-muted px-1 py-0.5">{p}</code>
            ))}
          </div>
        )}

        {view === "list" && tab === "skills" ? (
          <SkillsPanel open={open && tab === "skills"} />
        ) : view === "list" ? (
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
                  No saved automations yet. Describe one above, or start from a blank canvas.
                </p>
              ) : (
                saved.map((p) => {
                  const sched = schedules[p.id];
                  return (
                    <div key={p.id}>
                      <div className="flex w-full items-center gap-2 border-b px-3 py-2 last:border-b-0 hover:bg-muted">
                        <button
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() => openSaved(p)}
                        >
                          <ChevronRight className="size-3 shrink-0" />
                          <span className="text-sm">{p.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {p.nodeCount} step{p.nodeCount === 1 ? "" : "s"}
                          </span>
                          {p.lastRunAt && (
                            <span className="text-xs text-muted-foreground">
                              · ran {agoShort(p.lastRunAt)}
                            </span>
                          )}
                        </button>
                        <button
                          className={`flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
                            sched
                              ? "text-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          } disabled:cursor-not-allowed disabled:opacity-40`}
                          disabled={!p.vouched && !sched}
                          title={
                            !p.vouched && !sched
                              ? "Run it successfully once first — a schedule fires unattended"
                              : sched?.nextRun
                                ? `Next run ${new Date(sched.nextRun).toLocaleString()}`
                                : "Run this automation on a schedule"
                          }
                          onClick={() => openScheduleEditor(p.id, sched?.schedule)}
                        >
                          <Clock className="size-3" />
                          {sched ? describeSchedule(sched.schedule) : "Schedule"}
                        </button>
                        <button
                          className={`shrink-0 ${
                            confirmDelete === p.id
                              ? "text-destructive"
                              : "text-muted-foreground hover:text-destructive"
                          }`}
                          title={
                            sched && confirmDelete !== p.id
                              ? `This automation runs on a schedule (${describeSchedule(sched.schedule)}) — click again to delete both`
                              : confirmDelete === p.id
                                ? "Click again to delete the automation and its schedule"
                                : "Delete automation"
                          }
                          onClick={async () => {
                            // Deleting a scheduled automation silently kills a
                            // standing job, so it takes a second, armed click.
                            if (sched && confirmDelete !== p.id) {
                              setConfirmDelete(p.id);
                              return;
                            }
                            setConfirmDelete(null);
                            await deletePipeline(p.id).catch(() => {});
                            refresh();
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                      {editorFor === p.id && (
                        <form
                          className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs"
                          onSubmit={(e) => {
                            e.preventDefault();
                            saveSchedule(p.id);
                          }}
                        >
                          <span className="text-muted-foreground">Repeats</span>
                          <select
                            autoFocus
                            className="rounded-md border bg-background px-2 py-1"
                            value={editRepeat}
                            onChange={(e) => setEditRepeat(e.target.value)}
                          >
                            <option value="hourly">Every hour</option>
                            <option value="daily">Every day</option>
                            <option value="weekdays">Weekdays</option>
                            <option value="weekly">Specific days</option>
                            <option value="monthly">Monthly</option>
                          </select>
                          {editRepeat === "weekly" && (
                            <span className="flex gap-1">
                              {DAY_NAMES.map((label, day) => (
                                <button
                                  key={label}
                                  type="button"
                                  className={`rounded border px-1.5 py-0.5 ${
                                    editDays.includes(day)
                                      ? "bg-foreground text-background"
                                      : "text-muted-foreground hover:text-foreground"
                                  }`}
                                  onClick={() => toggleEditDay(day)}
                                >
                                  {label}
                                </button>
                              ))}
                            </span>
                          )}
                          {editRepeat === "monthly" && (
                            <label className="flex items-center gap-1">
                              <span className="text-muted-foreground">on day</span>
                              <input
                                type="number"
                                min={1}
                                max={31}
                                className="w-14 rounded-md border bg-background px-2 py-1"
                                value={editDom}
                                onChange={(e) => setEditDom(Number(e.target.value))}
                              />
                            </label>
                          )}
                          {editRepeat !== "hourly" && (
                            <label className="flex items-center gap-1">
                              <span className="text-muted-foreground">at</span>
                              <input
                                type="time"
                                className="rounded-md border bg-background px-2 py-1"
                                value={editTime}
                                onChange={(e) => setEditTime(e.target.value)}
                              />
                            </label>
                          )}
                          <span className="ml-auto flex gap-2">
                            <Button size="sm" type="submit">
                              {sched ? "Update" : "Set schedule"}
                            </Button>
                            {sched && (
                              <Button
                                size="sm"
                                variant="ghost"
                                type="button"
                                onClick={() => unschedule(p.id)}
                              >
                                Remove
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              type="button"
                              onClick={() => setEditorFor(null)}
                            >
                              Cancel
                            </Button>
                          </span>
                        </form>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {!schedulerRunning && Object.keys(schedules).length > 0 && (
              <p className="shrink-0 text-[11px] text-muted-foreground">
                Schedules are paused right now — they fire while Enio is open, or while{" "}
                <code>enio daemon</code> runs.
              </p>
            )}

            {drafts !== null && (
              <div className="max-h-40 shrink-0 overflow-y-auto rounded-md border">
                {drafts.length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">
                    Nothing repeated often enough yet — suggestions come from tool sequences
                    you've run at least three times.
                  </p>
                ) : (
                  drafts.map((d, i) => (
                    <button
                      key={i}
                      className="flex w-full items-center gap-2 border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted"
                      onClick={() => openDraft(d)}
                    >
                      <History className="size-3 shrink-0" />
                      <span className="min-w-0 truncate text-sm">{d.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{d.reason}</span>
                    </button>
                  ))
                )}
              </div>
            )}

            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={() => {
                  setCurrent({ name: "" });
                  setName("");
                  setComposedFrom("");
                  setHasRun(false);
                  setLastRunId(null);
                  setArtifacts([]);
                  setNodes([]);
                  setEdges([]);
                  setSelectedNode(null);
                  setView("canvas");
                }}
              >
                <Plus className="size-3.5" /> Blank canvas
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                disabled={suggesting}
                title="Find repeated tool sequences in your history and turn them into draft automations"
                onClick={suggest}
              >
                {suggesting ? <Loader2 className="size-3.5 animate-spin" /> : <History className="size-3.5" />}
                Suggest from my history
              </Button>
            </div>
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
                ← All automations
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
                  {selected.data.reply ? (
                    <div className="min-h-0 flex-1 overflow-y-auto rounded-md border bg-muted/40 p-2">
                      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Last output
                      </p>
                      <p className="whitespace-pre-wrap text-[11px] leading-snug">
                        {selected.data.reply}
                      </p>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Click a step to edit its guidance. Drag between the dots to connect steps —
                  connections that make no sense are refused.
                </p>
              )}

              <div className="mt-auto flex flex-col gap-1.5">
                <input
                  className="rounded-md border bg-transparent px-2 py-1 text-xs"
                  placeholder="Automation name"
                  value={name}
                  disabled={running}
                  onChange={(e) => setName(e.target.value)}
                />
                {running ? (
                  <Button size="sm" variant="destructive" className="gap-1" disabled={!stopTarget} onClick={stop}>
                    <Square className="size-3.5" /> Stop
                  </Button>
                ) : (
                  <Button size="sm" className="gap-1" disabled={busy || nodes.length === 0} onClick={run}>
                    <Play className="size-3.5" /> Run
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || running || nodes.length === 0 || (!current?.id && !hasRun)}
                  title={
                    !current?.id && !hasRun
                      ? "Run it once first — an automation is saved after you've seen it work"
                      : undefined
                  }
                  onClick={persist}
                >
                  {current?.id ? "Update" : "Save"}
                </Button>
                {/* Only a saved, vouched pipeline can teach chat to reach for
                    it — the same rule run_pipeline enforces. */}
                {current?.id && current?.vouched && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || running}
                    title="Write a skill so asking in plain words runs this automation"
                    onClick={async () => {
                      setError("");
                      try {
                        const skill = await savePipelineAsSkill(current.id);
                        setFinale(`Saved as the "${skill.name}" skill — plain chat can trigger it now.`);
                      } catch (err) {
                        setError(String(err?.message ?? err));
                      }
                    }}
                  >
                    Save as skill
                  </Button>
                )}
                {!current?.id && !hasRun && nodes.length > 0 && (
                  <p className="text-[10px] leading-tight text-muted-foreground">
                    Run it once — Save unlocks after you've seen it work.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
