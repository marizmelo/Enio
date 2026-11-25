import { getAbility } from "./abilities.js";
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
 * chat. Nothing here runs anything: the turn ends on the draft, and running
 * it is a click in the Automations panel — review, change, run, read the
 * outcome — exactly as for a draft composed there.
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

/**
 * The reply that carries a draft. Written by the harness, not the model: the
 * steps are the composer's closed-list choices and the sentence around them
 * is fixed, so nothing in it can claim work was done. A client that draws
 * the card shows the same steps with the button; one that does not still
 * has the whole plan in words.
 */
export function flowReply(draft: FlowDraft): string {
  const steps = draft.nodes.map((n, i) => `${i + 1}. **${n.title}** (${n.agent}): ${n.prompt}`).join("\n");
  const agents = agentsOf(draft.nodes).length;
  const lead =
    agents > 1
      ? "This takes more than one agent, so here is a plan. Nothing has run yet."
      : "Here is the plan. Nothing has run yet.";
  return (
    `${lead}\n\n${steps}\n\n` +
    `Open it in Automations to change a step, run it, and read what each step did. ` +
    `To skip the plan, start the message with @ and an agent's name.`
  );
}
