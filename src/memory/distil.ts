import { complete, repairJson } from "../model.js";
import { neutralizeControlTokens } from "../sanitize.js";
import type { Message } from "../types.js";

/**
 * A reply the user chose to keep, reduced to facts memory can hold.
 *
 * Automatic extraction is the model deciding what mattered, and it produced
 * `sky PREFERS being blue` from an echo test. A user pressing "remember
 * this" under an answer is a far better signal — but a 2,000-character reply
 * is not a fact, and dropping it into the facts table whole would give
 * every future memory block a paragraph to wade through. So the harness
 * distils: one bounded model call, temperature 0, "state the durable facts
 * in this answer as short standalone sentences", capped at five, PREVIEWED
 * before anything is written. A bad distillation costs a glance and an
 * edit, never a bad memory. The notes-transform pattern, applied to memory.
 *
 * Facts, not graph triples, on purpose: the closed relation vocabulary is
 * for the user's world (who works on what, with what); an answer the user
 * wants kept is usually knowledge ABOUT something, and free text is the
 * honest container for that. Search finds it either way.
 */

const DISTIL_SYSTEM = `You turn an assistant's answer into facts worth remembering.

Output ONLY a JSON object of this exact shape, with no prose and no markdown fence:
{"facts": ["...", "..."]}

Rules:
- Each fact is ONE short sentence that makes sense on its own, with no
  "this", "it" or "the above" — someone reading it later has no context.
- Keep specifics: names, numbers, dates, versions. Drop hedging, links,
  and anything about the assistant itself ("I found", "according to").
- Between one and five facts. Fewer is better. If the answer is a
  greeting, an apology, or contains nothing durable, return {"facts": []}.
- Never invent. Every fact must be stated in the answer.

Example answer:
Spain won the 2026 FIFA World Cup, defeating Argentina 1-0 in the final after extra time. Ferran Torres scored the winning goal in the 106th minute.

Example output:
{"facts": ["Spain won the 2026 FIFA World Cup, beating Argentina 1-0 after extra time.", "Ferran Torres scored the winning goal of the 2026 World Cup final in the 106th minute."]}`;

export interface DistilResult {
  ok: boolean;
  facts?: string[];
  reason?: string;
}

/** Hard cap on what one save can add: five short facts is a lot of memory
 *  for one answer, and a model that emits more is padding. */
const MAX_FACTS = 5;
const MAX_FACT_CHARS = 240;

export async function distilFacts(question: string, answer: string): Promise<DistilResult> {
  const text = neutralizeControlTokens(answer).trim();
  if (text.length < 20) return { ok: false, reason: "There is nothing here to remember." };

  const messages: Message[] = [
    { role: "system", content: DISTIL_SYSTEM },
    {
      role: "user",
      content:
        (question.trim() ? `The user asked: ${neutralizeControlTokens(question).slice(0, 400)}\n\n` : "") +
        `Answer:\n${text.slice(0, 6000)}`,
    },
  ];

  try {
    const result = await complete(messages, [], {}, undefined, { temperature: 0 });
    const match = /\{[\s\S]*\}/.exec(result.content);
    if (!match) return { ok: false, reason: "The model returned nothing usable." };
    const parsed = JSON.parse(repairJson(match[0])) as { facts?: unknown };
    const facts = (Array.isArray(parsed.facts) ? parsed.facts : [])
      .map((f) => String(f ?? "").trim())
      .filter((f) => f.length >= 8)
      .map((f) => f.slice(0, MAX_FACT_CHARS));
    // Dedupe case-insensitively BEFORE capping: a padded model repeats
    // itself, and a repeat must not spend one of the five slots.
    const seen = new Set<string>();
    const unique = facts
      .filter((f) => {
        const k = f.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, MAX_FACTS);
    if (unique.length === 0) return { ok: false, reason: "Nothing in that answer reads as a durable fact." };
    return { ok: true, facts: unique };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
