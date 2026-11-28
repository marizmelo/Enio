import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Minus, Pencil, Play, Save, Square, Workflow, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { runDraft, stopPipeline } from "@/lib/pipelines";

/**
 * A plan for a request that takes more than one agent, run where it was
 * asked for.
 *
 * The request was made in the conversation, so the conversation is where it
 * is run and where its answer arrives. The first version of this card only
 * opened the Automations canvas: the plan ran there, the results stayed
 * there, and the thread the person came back to still had no answer in it.
 * Now Run happens here — each step ticks as its agent works — and the
 * server writes what the run did back into the thread as a reply. The
 * canvas is for what it is good at: changing the plan before running it,
 * and saving it afterwards.
 *
 * Talks to the rest of the app through window events rather than props: the
 * canvas is mounted once at the top of the app and the thread owns its
 * messages, while a card can sit anywhere in a thread, restored ones too.
 *   enio:open-flow     this card → canvas: edit or save this graph
 *   enio:flow-edited   canvas → this card: the graph as changed
 *   enio:flow-outcome  this card → thread: the reply to append
 */
export function FlowWidget({ id, request, nodes = [], edges = [], ran = null, sessionId = null }) {
  // The proposal is what arrived; `graph` is what will run.
  const [graph, setGraph] = useState({ nodes, edges });
  const [edited, setEdited] = useState(false);
  const [phase, setPhase] = useState(ran ?? "draft"); // draft | running | succeeded | failed | cancelled
  const [steps, setSteps] = useState({}); // nodeId -> running | finished | failed | skipped
  const [activity, setActivity] = useState({}); // nodeId -> the tool it is in
  const [stopTarget, setStopTarget] = useState(null);
  const [runId, setRunId] = useState(null);
  const [error, setError] = useState("");
  // A run outlives a re-render; a second click must not start a second run.
  const busy = useRef(false);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  useEffect(() => {
    const shape = (g) =>
      JSON.stringify([g.nodes.map((n) => [n.id, n.abilityId, n.prompt, n.account ?? ""]), (g.edges ?? []).map((x) => [x.from, x.to])]);
    const onEdited = (e) => {
      if (e.detail?.id !== id || !Array.isArray(e.detail.nodes) || e.detail.nodes.length === 0) return;
      const next = { nodes: e.detail.nodes, edges: e.detail.edges ?? [] };
      // Opened, looked at, sent back unchanged: still the plan that ran.
      // Without this a glance at the canvas wiped "ran" off the card.
      if (shape(next) === shape(graphRef.current)) return;
      // The canvas knows an ability's title but not its agent; keep the
      // agent the server named for any step whose ability did not change.
      const agents = new Map(graphRef.current.nodes.map((n) => [`${n.id}:${n.abilityId}`, n.agent]));
      next.nodes = next.nodes.map((n) => ({ ...n, agent: agents.get(`${n.id}:${n.abilityId}`) ?? n.agent }));
      setGraph(next);
      setEdited(true);
      // An edited plan has not run, whatever the one before it did.
      setPhase("draft");
      setSteps({});
      setRunId(null);
      setError("");
    };
    window.addEventListener("enio:flow-edited", onEdited);
    return () => window.removeEventListener("enio:flow-edited", onEdited);
  }, [id]);

  if (graph.nodes.length === 0) return null;
  const running = phase === "running";
  const agents = new Set(graph.nodes.map((n) => n.agent).filter(Boolean)).size;

  const run = async () => {
    if (busy.current) return;
    busy.current = true;
    setPhase("running");
    setSteps({});
    setActivity({});
    setError("");
    let outcome = "failed";
    try {
      await runDraft(
        {
          // The account a step was set to on the canvas rides along, or a
          // plan edited there and run here would run without it.
          nodes: graph.nodes.map((n) => ({
            id: n.id,
            abilityId: n.abilityId,
            prompt: n.prompt,
            ...(n.account ? { account: n.account } : {}),
          })),
          edges: graph.edges,
          // Names the conversation, so the server writes the outcome into it.
          sessionId,
          flowId: id,
          // Recorded on anything the run creates, as why it exists.
          request,
        },
        (event) => {
          if (event.type === "run_started") {
            setStopTarget(event.pipelineId);
            setRunId(event.runId);
          } else if (event.type === "node_started") {
            setSteps((s) => ({ ...s, [event.nodeId]: "running" }));
          } else if (event.type === "node_tool") {
            setActivity((a) => ({ ...a, [event.nodeId]: event.tool }));
          } else if (event.type === "node_finished") {
            setSteps((s) => ({ ...s, [event.nodeId]: "finished" }));
          } else if (event.type === "node_failed") {
            setSteps((s) => ({ ...s, [event.nodeId]: "failed" }));
          } else if (event.type === "node_skipped") {
            setSteps((s) => ({ ...s, [event.nodeId]: "skipped" }));
          } else if (event.type === "run_finished") {
            outcome = event.status ?? "failed";
            if (event.error) setError(event.error);
          } else if (event.type === "outcome") {
            window.dispatchEvent(
              new CustomEvent("enio:flow-outcome", {
                // The cards of any message a step wrote ride with the reply.
                detail: { sessionId, flowId: id, reply: event.reply, artifacts: event.artifacts ?? [], widgets: event.widgets ?? [] },
              }),
            );
          }
        },
      );
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      busy.current = false;
      setStopTarget(null);
      setPhase(outcome);
    }
  };

  const stop = () => {
    if (stopTarget) stopPipeline(stopTarget).catch((err) => setError(String(err?.message ?? err)));
  };

  const openCanvas = (purpose) =>
    window.dispatchEvent(
      new CustomEvent("enio:open-flow", {
        detail: {
          id,
          request,
          nodes: graph.nodes,
          edges: graph.edges,
          // A run that succeeded here vouches for the graph on the canvas, so
          // Save does not ask for a second run of something just watched.
          runId: purpose === "save" && phase === "succeeded" ? runId : null,
        },
      }),
    );

  const status =
    phase === "running"
      ? "running"
      : phase === "succeeded"
        ? "ran · the result is below"
        : phase === "failed"
          ? "did not finish"
          : phase === "cancelled"
            ? "stopped"
            : edited
              ? "edited · nothing has run"
              : "nothing has run";
  // The reply above lists the steps as proposed. Once they have been
  // changed, or are running, the card is where the current ones are.
  const showSteps = edited || phase !== "draft";

  return (
    <div className="my-2 rounded-md border">
      <div className="flex items-center gap-3 px-3 py-2">
        <Workflow className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{request}</p>
          <p className="text-xs text-muted-foreground">
            {graph.nodes.length} step{graph.nodes.length === 1 ? "" : "s"}
            {agents > 1 ? ` · ${agents} agents` : ""} · {status}
          </p>
        </div>
        {running ? (
          <Button size="sm" variant="destructive" className="gap-1" disabled={!stopTarget} onClick={stop}>
            <Square className="size-3.5" /> Stop
          </Button>
        ) : (
          <>
            {phase === "succeeded" && runId && (
              <Button size="sm" variant="ghost" className="gap-1" onClick={() => openCanvas("save")}>
                <Save className="size-3.5" /> Save
              </Button>
            )}
            <Button size="sm" variant="ghost" className="gap-1" onClick={() => openCanvas("edit")}>
              <Pencil className="size-3.5" /> Edit
            </Button>
            <Button size="sm" className="gap-1" onClick={run}>
              <Play className="size-3.5" /> {phase === "draft" ? "Run" : "Run again"}
            </Button>
          </>
        )}
      </div>

      {showSteps && (
        <ol className="border-t px-3 py-2 text-xs">
          {graph.nodes.map((n, i) => {
            const s = steps[n.id];
            return (
              <li key={n.id} className="flex items-start gap-2 py-0.5">
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                  {s === "running" ? (
                    <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                  ) : s === "finished" ? (
                    <Check className="size-3.5 text-emerald-600" />
                  ) : s === "failed" ? (
                    <X className="size-3.5 text-destructive" />
                  ) : s === "skipped" ? (
                    <Minus className="size-3.5 text-muted-foreground" />
                  ) : (
                    <span className="tabular-nums text-muted-foreground">{i + 1}</span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{n.title ?? n.abilityId}</span>
                  {n.agent ? <span className="text-muted-foreground"> · {n.agent}</span> : null}
                  {s === "running" && activity[n.id] ? (
                    <span className="text-muted-foreground"> · {activity[n.id]}</span>
                  ) : null}
                  {/* The guidance, when it is not the text already shown above. */}
                  {edited && !s ? (
                    <span className="block truncate text-muted-foreground" title={n.prompt}>
                      {n.prompt}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {error && <p className="border-t px-3 py-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
