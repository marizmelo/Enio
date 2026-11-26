import { randomUUID } from "node:crypto";
import { getAbility } from "./abilities.js";
import { logMessage } from "./memory/store.js";
import { recordTurn } from "./memory/traces.js";
import { currentModelId } from "./model-settings.js";
import type { Registry } from "./tools/index.js";

/**
 * A request that takes more than one agent becomes a plan, not an answer.
 *
 * Routing sends a message to exactly one specialist, and the specialists'
 * tools are disjoint on purpose. So "search the web for budget laptops and
 * email me a summary" has no right route: the researcher can find them and
 * cannot send, the mail agent can send and cannot look. One hop stays one
 * hop, which leaves the request half done however well it is routed.
 *
 * The answer is the one the project already has for work that spans
 * specialists: a pipeline, drafted by the model as a choice from the closed
 * list of abilities, edited by the user, and executed by the harness one
 * narrow turn per step. This module only decides when to draft one from
 * chat. Nothing here runs anything: the turn ends on the draft. Running it
 * is a click on the card under that reply, and what the run did comes back
 * into the same thread as a reply (flowOutcome) — the request was made in
 * the conversation, so that is where its answer belongs. The Automations
 * canvas is for changing the plan and for keeping it, not for reading
 * results: the first version sent people there to run it, and they came
 * back to a thread that had no answer in it.
 *
 * Detection is two stages because neither works alone (measured,
 * scripts/flow-bench.mjs). The composer by itself over-decomposes: asked
 * about every request it called 11 of 127 single-agent ones a flow, and it
 * costs about two seconds. A grammar check in front — the request joins two
 * things with "and" or "then" — lets 9 of those 127 through, of which the
 * composer wrongly kept 1, and still passed all 24 multi-agent requests, of
 * which the composer drafted 22. So the two seconds are paid on roughly one
 * request in fourteen, and an ordinary request almost never meets a plan.
 */

export interface FlowStep {
  id: string;
  abilityId: string;
  /** The ability's name as the Automations canvas shows it. */
  title: string;
  /** The agent that runs the step. */
  agent: string;
  prompt: string;
}

export interface FlowDraft {
  /** Ties a later run back to this draft, so a reopened conversation can
   *  say the plan already ran instead of offering it as untouched. */
  id: string;
  /** What the user asked, kept as the automation's description if saved. */
  request: string;
  nodes: FlowStep[];
  edges: Array<{ from: string; to: string }>;
}

/** Two things joined in sequence. Deliberately loose: it only has to keep
 *  the composer away from the requests that plainly are one thing. */
const JOINED = /\b(?:and|then|after that|afterwards)\b/i;

/** The explicit door, for a request that needs two agents and says so in one
 *  clause ("email me a summary of today's news") — the grammar above cannot
 *  see those. A prefix rather than "make a plan for...", which is also how
 *  someone asks for a travel plan. */
const ASKED = /^\s*plan\s*:\s*/i;

/**
 * Whether a message is worth showing to the composer, and why.
 * `asked`: the user wrote "plan:". `joined`: it reads as two steps.
 * Long messages are left alone — a pasted page has "and" in it.
 */
export function flowCandidate(text: string): { why: "asked" | "joined"; request: string } | null {
  const t = text.trim();
  if (t.length > 400) return null;
  if (ASKED.test(t)) {
    const request = t.replace(ASKED, "").trim();
    return request.length >= 8 ? { why: "asked", request } : null;
  }
  if (t.split(/\s+/).length < 5) return null;
  return JOINED.test(t) ? { why: "joined", request: t } : null;
}

/** The agents a set of steps would need. One agent is an ordinary turn: its
 *  own tool loop already does several things in a row. */
export function agentsOf(nodes: Array<{ abilityId: string }>): string[] {
  return [...new Set(nodes.map((n) => getAbility(n.abilityId)?.specialist).filter((s): s is string => Boolean(s)))];
}

/**
 * The draft for a message, or null when it is an ordinary request.
 *
 * Null on every failure too: a composer that errored, named nothing usable
 * or found one agent's worth of work means the router handles the message
 * as it always has. A plan is an offer, never a way for a turn to fail.
 */
export async function draftFlow(text: string, registry: Registry): Promise<FlowDraft | null> {
  const candidate = flowCandidate(text);
  if (!candidate) return null;
  try {
    // Loaded here, not at the top: pipelines.ts imports the turn loop to run
    // its steps, and the turn loop imports this.
    const { composePipeline } = await import("./pipelines.js");
    const { mentionContext } = await import("./mentions.js");
    const composed = await composePipeline(candidate.request, registry, mentionContext(registry).servers);
    if (!composed.ok || !composed.nodes || composed.nodes.length === 0) return null;
    // Asked for by name, even one step is a plan. Inferred, it has to need
    // two agents — otherwise the plan is ceremony around an ordinary turn.
    if (candidate.why === "joined" && agentsOf(composed.nodes).length < 2) return null;
    return {
      id: randomUUID(),
      request: candidate.request,
      nodes: composed.nodes.map((n) => {
        const ability = getAbility(n.abilityId);
        return {
          id: n.id,
          abilityId: n.abilityId,
          title: ability?.title ?? n.abilityId,
          agent: ability?.specialist ?? "generalist",
          prompt: n.prompt,
        };
      }),
      edges: composed.edges ?? [],
    };
  } catch {
    return null;
  }
}

const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
};

/**
 * Figures a step's guidance carries that the request did not: prices,
 * years, counts, times.
 *
 * The composer adds them. Asked for "the best budget laptops" it wrote
 * "under $600, focusing on top models in 2024", in November 2026, and the
 * researcher then failed to find what nobody had asked for. Telling it not
 * to was measured and rejected: every wording cost the composer real plans
 * (22 of 24 drafted fell to 19 or 20) and it still invented a figure in two
 * or three drafts. So the harness says which figures are the drafter's,
 * where the person is already reading the step and one Edit away from
 * removing them. Figures only — a closed thing a comparison can decide;
 * an invented adjective is not.
 */
export function addedFigures(request: string, prompt: string): string[] {
  const said = new Set<string>(request.match(/\d+/g) ?? []);
  for (const word of request.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (NUMBER_WORDS[word]) said.add(NUMBER_WORDS[word]!);
  }
  const added: string[] = [];
  for (const figure of prompt.match(/[$€£]?\d[\d,.:]*\d|[$€£]?\d/g) ?? []) {
    const digits = figure.match(/\d+/g) ?? [];
    if (digits.every((d) => said.has(d))) continue;
    if (!added.includes(figure)) added.push(figure);
  }
  return added;
}

/**
 * The reply that carries a draft. Written by the harness, not the model: the
 * steps are the composer's closed-list choices and the sentence around them
 * is fixed, so nothing in it can claim work was done. A client that draws
 * the card shows the same steps with the button; one that does not still
 * has the whole plan in words.
 */
export function flowReply(draft: FlowDraft): string {
  const steps = draft.nodes
    .map((n, i) => {
      const added = addedFigures(draft.request, n.prompt);
      return (
        `${i + 1}. **${n.title}** (${n.agent}): ${n.prompt}` +
        (added.length > 0 ? `\n   Not in your request, added by the drafter: ${added.join(", ")}.` : "")
      );
    })
    .join("\n");
  const agents = agentsOf(draft.nodes).length;
  const lead =
    agents > 1
      ? "This takes more than one agent, so here is a plan. Nothing has run yet."
      : "Here is the plan. Nothing has run yet.";
  return (
    `${lead}\n\n${steps}\n\n` +
    `Run it from the card below and the result comes back here. Edit changes a step first. ` +
    `To skip the plan, start the message with @ and an agent's name.`
  );
}

export interface FlowStepResult {
  nodeId: string;
  status: "finished" | "failed" | "skipped";
  reply: string;
  error?: string;
  /** The kinds of thing the step's tools actually produced (document,
   *  file, image, email_draft...), as the executor recovered them from tool
   *  output. Absent means not known, and nothing is concluded from it. */
  made?: string[];
}

const KIND_WORDS: Record<string, string> = {
  document: "a document",
  file: "a file",
  image: "an image",
  email_draft: "an email draft",
  plan: "a plan",
};

/**
 * What a finished step was for and did not make, or null.
 *
 * The executor calls a step finished when its turn returns, and a turn
 * returns whether or not the agent did the thing: the first plan run from
 * a conversation counted "2 of 2 steps finished" above a second step whose
 * whole reply was the harness's own "I described doing that, but I did not
 * actually run anything". Only for abilities that exist to produce a thing
 * rather than an answer (no "text" among their outputs) — for those, the
 * thing is the result, and its absence is a fact the harness holds.
 */
function madeNothing(abilityId: string, r: FlowStepResult): string | null {
  const outputs = getAbility(abilityId)?.outputs ?? [];
  if (r.made === undefined || outputs.length === 0 || outputs.includes("text")) return null;
  if (r.made.some((kind) => (outputs as string[]).includes(kind))) return null;
  return KIND_WORDS[outputs[0]!] ?? `a ${outputs[0]}`;
}

/** How much of a step's reply the outcome carries when it is not the last
 *  one. The last finished step is the answer and is given whole; the ones
 *  before it are how the answer was reached, and a researcher's full reply
 *  ahead of every result would bury the result — and fill a small context
 *  window on the next turn. */
const EARLIER_REPLY_CHARS = 600;

/**
 * What a run did, as the reply that goes back into the conversation.
 *
 * Assembled by the harness from the executor's own results, never written
 * by a model: a summary step would be one more generation able to say a
 * failed step worked. Each step is named with the agent that ran it and
 * carries what that agent actually replied, or why it did not run.
 * Titles and agents come from the ability, not from the client's copy of
 * the graph, which may have been edited to say anything.
 */
export function flowOutcome(
  nodes: Array<{ id: string; abilityId: string }>,
  results: FlowStepResult[],
  status: "succeeded" | "failed" | "cancelled",
): string {
  const byId = new Map(results.map((r) => [r.nodeId, r]));
  const ordered = nodes.filter((n) => byId.has(n.id));
  const finished = ordered.filter((n) => byId.get(n.id)!.status === "finished");
  const last = finished[finished.length - 1]?.id;
  const hollow = finished.filter((n) => madeNothing(n.abilityId, byId.get(n.id)!) !== null).length;
  const count =
    `${finished.length} of ${nodes.length} step${nodes.length === 1 ? "" : "s"} finished` +
    (hollow > 0 ? `, ${hollow} of them without making what it was for` : "");
  const lead =
    status === "succeeded"
      ? `The plan ran: ${count}.`
      : status === "cancelled"
        ? `You stopped the plan: ${count}.`
        : `The plan did not finish: ${count}.`;
  const blocks = nodes.map((n, i) => {
    const ability = getAbility(n.abilityId);
    const head = `**${i + 1}. ${ability?.title ?? n.abilityId}** (${ability?.specialist ?? "generalist"})`;
    const r = byId.get(n.id);
    if (!r) return `${head}: not run.`;
    if (r.status === "failed") return `${head}: failed. ${r.error ?? "No reason was given."}`;
    if (r.status === "skipped") return `${head}: not run, ${r.error ?? "an earlier step did not finish"}.`;
    const reply = r.reply.trim() || "(it finished without saying anything)";
    const shown =
      n.id === last || reply.length <= EARLIER_REPLY_CHARS
        ? reply
        : `${reply.slice(0, EARLIER_REPLY_CHARS).trimEnd()}…`;
    const missing = madeNothing(n.abilityId, r);
    return missing ? `${head}: finished without making ${missing}.\n${shown}` : `${head}\n${shown}`;
  });
  return `${lead}\n\n${blocks.join("\n\n")}`;
}

/**
 * Put a run's outcome into the conversation it was run from, and return the
 * reply. The transcript is what a reopened conversation shows and what the
 * client sends back as history on the next turn, so writing it here is what
 * makes "now send that to Ana" a follow-up to something.
 *
 * The trace step is written before the message so restore pairs them: it
 * matches a step to the first reply at or after the step's time. It carries
 * the draft's id (the card learns it ran) and the files the steps made
 * (the reply keeps its click-to-open chips).
 */
export function recordFlowOutcome(run: {
  sessionId: string;
  flowId: string | null;
  runId: string;
  nodes: Array<{ id: string; abilityId: string }>;
  results: FlowStepResult[];
  status: "succeeded" | "failed" | "cancelled";
  artifacts: Array<{ type: string; path: string }>;
}): string {
  const reply = flowOutcome(run.nodes, run.results, run.status);
  const startedAt = Date.now();
  try {
    recordTurn({
      sessionId: run.sessionId,
      question: "(ran the plan)",
      reply,
      specialist: "generalist",
      systemPrompt: "(harness: flow_run)",
      memoryBlock: "",
      startedAt,
      durationMs: 0,
      iterations: 0,
      model: currentModelId(),
      steps: [
        {
          seq: 0,
          kind: "harness",
          name: "flow_run",
          args: JSON.stringify({ flowId: run.flowId, runId: run.runId, status: run.status, artifacts: run.artifacts }),
          output: reply,
          error: null,
          durationMs: 0,
        },
      ],
    });
  } catch {
    /* Tracing must never cost the outcome its place in the thread. */
  }
  logMessage(run.sessionId, "assistant", reply);
  return reply;
}
