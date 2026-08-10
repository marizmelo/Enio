import { complete, repairJson } from "./model.js";
import { PLAN_KINDS, type PlanKind, type PlanStep } from "./plans.js";
import type { Message } from "./types.js";

/**
 * Changing a proposed plan by describing the change.
 *
 * Editing a step by hand is exact and sometimes tedious: "do this in Python
 * instead" is one sentence and six lines of rewriting. This is the second half
 * of modifying a plan, and it is deliberately the *weaker* half — the model
 * proposes a revision, the user reads it in the same editor, and nothing runs
 * until they approve. A bad revision costs a glance, not an action.
 *
 * Framed as a transformation rather than an invention: the current steps go in
 * as JSON and revised steps come back, with an instruction to leave untouched
 * anything the request did not mention. That is much closer to the
 * classification this model size is good at than "write me a plan" is, and it
 * makes an unchanged step byte-identical rather than plausibly reworded.
 *
 * Greedy, for the reason the router is: there is one right answer to "make it
 * Python", and sampling only adds variance to a structured edit.
 */

export interface ReviseResult {
  ok: boolean;
  steps?: PlanStep[];
  reason?: string;
}

export async function revisePlan(
  steps: PlanStep[],
  instruction: string,
  summary: string,
): Promise<ReviseResult> {
  const want = instruction.trim();
  if (!want) return { ok: false, reason: "Say what to change." };

  const current = steps.map((s) => ({
    summary: s.summary,
    script: s.script,
    kind: s.kind ?? "applescript",
  }));

  const messages: Message[] = [
    {
      role: "system",
      content:
        `You revise a list of steps that will run on the user's Mac. ` +
        `The plan is: ${summary}\n\n` +
        `Reply with ONLY a JSON array, nothing else. Each element is:\n` +
        `{"summary": "what it does", "script": "the code", "kind": "applescript|shell|python"}\n\n` +
        `Rules:\n` +
        `- Leave any step the request does not mention exactly as it is, character for character.\n` +
        `- Keep the same order unless asked to change it.\n` +
        `- "kind" says which interpreter runs the script. Prefer python or shell over applescript.\n` +
        `- Return every step, not only the changed ones.`,
    },
    {
      role: "user",
      content: `Current steps:\n${JSON.stringify(current, null, 2)}\n\nChange requested: ${want}`,
    },
  ];

  try {
    const result = await complete(messages, [], {}, undefined, { temperature: 0 });
    // The array may arrive wrapped in prose or a fence; take the outermost
    // bracketed run and let the existing repair handle the JSON small models
    // actually produce.
    const match = /\[[\s\S]*\]/.exec(result.content);
    if (!match) return { ok: false, reason: "The model did not return a list of steps." };

    const parsed = JSON.parse(repairJson(match[0])) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { ok: false, reason: "The revision came back empty." };
    }

    const revised: PlanStep[] = parsed
      .map((s) => ({
        summary: String(s?.summary ?? "").trim(),
        script: String(s?.script ?? ""),
        kind: (PLAN_KINDS.includes(s?.kind as PlanKind)
          ? s.kind
          : "applescript") as PlanKind,
      }))
      .filter((s) => s.script.trim());

    if (revised.length === 0) {
      return { ok: false, reason: "Every revised step was empty." };
    }
    return { ok: true, steps: revised };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
