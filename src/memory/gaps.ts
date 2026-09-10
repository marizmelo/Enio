import { getDb } from "./db.js";
import { distinctiveTerms, looksLikeQuestion } from "./terms.js";

/**
 * The gap ledger: what was asked that nothing covered.
 *
 * Every turn already ends with a verdict on where the answer came from (the
 * `basis` step: web, files, memory, this conversation, or the model's own
 * weights). The last case was recorded and then thrown away — the one
 * signal that says "here is something the person wanted and memory did not
 * have", which is what curiosity needs to be about anything in particular.
 *
 * Derived, never authoritative: rebuilt from the traces by `enio reindex`,
 * like the graph. Recorded by the harness from facts the turn already
 * established, never by the model judging its own ignorance. A gap closes
 * when a later fact carries every word it was asked about — the "learned it
 * later" half — and a forgotten gap comes back on reindex, the same way a
 * forgotten summary does.
 */

export interface Gap {
  id: number;
  key: string;
  question: string;
  specialist: string;
  firstAt: number;
  lastAt: number;
  count: number;
  resolvedBy: number | null;
}

export interface TurnOutcome {
  question: string;
  specialist: string;
  basis: string;
  /** Names of the tools that ran, in order. */
  toolNames: string[];
  skillsInvoked: boolean;
  at: number;
}

/**
 * Whether a finished turn is a gap. All of these must hold, and each is a
 * fact the turn established rather than a judgement: the answer came from
 * the model's weights (nothing ran, nothing covered it); the input had the
 * shape of a question; no skill was invoked, since the skill may have been
 * the answer; the agent was not the coder, whose work is files, not
 * knowledge; and no tool ran except `recall` — a recall that found nothing
 * is the very definition of a gap, where a weather lookup is an answer.
 */
export function isGap(t: TurnOutcome): boolean {
  if (t.basis !== "model") return false;
  if (!looksLikeQuestion(t.question)) return false;
  if (t.skillsInvoked) return false;
  if (t.specialist === "coder") return false;
  if (t.toolNames.some((n) => n !== "recall")) return false;
  return gapKey(t.question) !== null;
}

/** The distinctive terms, sorted, as one string: two phrasings of the same
 *  ask share a key, and a key compares as whole words — "port" is not a
 *  word of "airport". */
export function gapKey(question: string): string | null {
  const terms = distinctiveTerms(question).sort();
  return terms.length === 0 ? null : terms.join(" ");
}

/** Record the turn if it is a gap. Returns whether it was. Never throws:
 *  this runs at the end of a turn, and tracing must never break one. */
export function noteTurn(t: TurnOutcome): boolean {
  try {
    if (!isGap(t)) return false;
    const key = gapKey(t.question)!;
    // Asked again after it was resolved: the fact no longer covers it (or
    // was forgotten), so it reopens rather than counting against a closed row.
    getDb()
      .prepare(
        `INSERT INTO gaps (key, question, specialist, first_at, last_at, count, resolved_by)
         VALUES (?, ?, ?, ?, ?, 1, NULL)
         ON CONFLICT(key) DO UPDATE SET
           count = count + 1, last_at = excluded.last_at,
           question = excluded.question, resolved_by = NULL`,
      )
      .run(key, t.question.trim().slice(0, 500), t.specialist, t.at, t.at);
    return true;
  } catch {
    return false;
  }
}

/** Close every open gap whose words all appear in this fact. Called by
 *  rememberFact after the insert; cheap because open gaps are few. */
export function resolveGaps(factId: number, factText: string): number {
  const words = new Set(factText.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const db = getDb();
  const open = db.prepare(`SELECT id, key FROM gaps WHERE resolved_by IS NULL`).all() as Array<{ id: number; key: string }>;
  const close = db.prepare(`UPDATE gaps SET resolved_by = ? WHERE id = ?`);
  let n = 0;
  for (const g of open) {
    if (g.key.split(" ").every((term) => words.has(term))) {
      close.run(factId, g.id);
      n++;
    }
  }
  return n;
}

const rowToGap = (r: Record<string, unknown>): Gap => ({
  id: Number(r.id),
  key: String(r.key),
  question: String(r.question),
  specialist: String(r.specialist),
  firstAt: Number(r.first_at),
  lastAt: Number(r.last_at),
  count: Number(r.count),
  resolvedBy: r.resolved_by == null ? null : Number(r.resolved_by),
});

/** Open gaps, most asked first, then most recent. */
export function openGaps(limit = 50): Gap[] {
  return (
    getDb()
      .prepare(`SELECT * FROM gaps WHERE resolved_by IS NULL ORDER BY count DESC, last_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[]
  ).map(rowToGap);
}

/** Every gap, open first, for the Memory panel — a resolved one is shown
 *  dimmed, because "it learned that later" is the loop closing. */
export function listGaps(limit = 200): Gap[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM gaps ORDER BY (resolved_by IS NOT NULL), count DESC, last_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[]
  ).map(rowToGap);
}

export function forgetGap(id: number): boolean {
  return getDb().prepare(`DELETE FROM gaps WHERE id = ?`).run(id).changes > 0;
}

/**
 * Replay the traces: every turn's `basis` and `skill_invoked` harness steps
 * and tool steps are in turn_steps, so the same predicate reproduces the
 * ledger from scratch, then the current facts close what they cover. How
 * `enio reindex` regenerates it.
 */
export function rebuildGaps(): number {
  const db = getDb();
  db.exec(`DELETE FROM gaps`);
  const turns = db
    .prepare(`SELECT id, question, specialist, started_at AS at FROM turns ORDER BY id`)
    .all() as Array<{ id: number; question: string; specialist: string; at: number }>;
  const stepsFor = db.prepare(`SELECT kind, name, args FROM turn_steps WHERE turn_id = ? ORDER BY seq`);
  let recorded = 0;
  for (const t of turns) {
    const steps = stepsFor.all(t.id) as Array<{ kind: string; name: string | null; args: string | null }>;
    const basisStep = steps.find((s) => s.kind === "harness" && s.name === "basis");
    if (!basisStep) continue;
    let basis = "";
    try {
      basis = String((JSON.parse(basisStep.args ?? "{}") as { basis?: string }).basis ?? "");
    } catch {
      continue;
    }
    if (
      noteTurn({
        question: t.question,
        specialist: t.specialist,
        basis,
        toolNames: steps.filter((s) => s.kind === "tool").map((s) => s.name ?? ""),
        skillsInvoked: steps.some((s) => s.kind === "harness" && s.name === "skill_invoked"),
        at: t.at,
      })
    ) {
      recorded++;
    }
  }
  const facts = db.prepare(`SELECT id, text FROM facts WHERE valid_to IS NULL`).all() as Array<{ id: number; text: string }>;
  for (const f of facts) resolveGaps(f.id, f.text);
  return recorded;
}
