import { cosine, fromBlob, getDb, toBlob } from "./db.js";
import { embed } from "./embed.js";

/**
 * Two mechanisms that change behaviour over time without touching weights.
 *
 * PREFERENCES are how the user wants the assistant to act. They are kept apart
 * from facts on purpose: facts compete for space under relevance ranking, and a
 * standing instruction that only fires when it happens to rank well is not a
 * standing instruction. Preferences are few, and all of them are injected every
 * turn.
 *
 * EXEMPLARS are (question, good answer) pairs captured when the user approves
 * or corrects a response. The nearest few are retrieved and shown as examples.
 * This is the closest thing to learning available without training: it changes
 * behaviour, generalises to similar questions, works immediately, and is
 * trivially reversible — which fine-tuning is not.
 */

const now = () => Date.now();

/* ---------- preferences ------------------------------------------------- */

export interface Preference {
  id: number;
  text: string;
  createdAt: number;
}

export function addPreference(text: string): { added: boolean; reason?: string } {
  const clean = text.trim();
  if (clean.length < 3) return { added: false, reason: "too short" };

  const db = getDb();
  const existing = db.prepare(`SELECT id FROM preferences WHERE text = ?`).get(clean);
  if (existing) return { added: false, reason: "already set" };

  db.prepare(`INSERT INTO preferences (text, created_at, active) VALUES (?, ?, 1)`)
    .run(clean, now());
  return { added: true };
}

export function listPreferences(): Preference[] {
  return getDb()
    .prepare(
      `SELECT id, text, created_at AS createdAt FROM preferences
       WHERE active = 1 ORDER BY id`,
    )
    .all() as Preference[];
}

export function removePreference(idOrText: string): boolean {
  const db = getDb();
  const asId = Number(idOrText);
  const res = Number.isFinite(asId)
    ? db.prepare(`DELETE FROM preferences WHERE id = ?`).run(asId)
    : db.prepare(`DELETE FROM preferences WHERE text = ?`).run(idOrText);
  return res.changes > 0;
}

/**
 * Preferences are capped, and the cap is deliberate. Twenty accumulated
 * instructions is already more than a small model reliably honours; past that
 * they start contradicting each other and the model follows whichever it
 * noticed last. Better to keep the newest few and let the user prune.
 */
const MAX_INJECTED_PREFERENCES = 12;

export function preferenceBlock(): string {
  const prefs = listPreferences().slice(-MAX_INJECTED_PREFERENCES);
  if (prefs.length === 0) return "";
  return (
    `How this user wants you to respond:\n` +
    prefs.map((p) => `- ${p.text}`).join("\n")
  );
}

/* ---------- exemplars --------------------------------------------------- */

export interface Exemplar {
  id: number;
  question: string;
  answer: string;
}

export async function addExemplar(
  question: string,
  answer: string,
): Promise<{ added: boolean; reason?: string }> {
  const q = question.trim();
  const a = answer.trim();
  if (q.length < 5 || a.length < 5) return { added: false, reason: "too short" };
  // A 4000-token exemplar poisons the context budget for everything else.
  if (a.length > 2000) return { added: false, reason: "answer too long to use as an example" };

  const db = getDb();
  if (db.prepare(`SELECT id FROM exemplars WHERE question = ?`).get(q)) {
    db.prepare(`UPDATE exemplars SET answer = ? WHERE question = ?`).run(a, q);
    return { added: true };
  }

  const vec = await embed(q);
  db.prepare(
    `INSERT INTO exemplars (question, answer, embedding, created_at) VALUES (?, ?, ?, ?)`,
  ).run(q, a, vec ? toBlob(vec) : null, now());
  return { added: true };
}

export function listExemplars(): Exemplar[] {
  return getDb()
    .prepare(`SELECT id, question, answer FROM exemplars ORDER BY id`)
    .all() as Exemplar[];
}

export function removeExemplar(id: number): boolean {
  return getDb().prepare(`DELETE FROM exemplars WHERE id = ?`).run(id).changes > 0;
}

/**
 * Retrieve the closest exemplars to the current question.
 *
 * The similarity floor is high on purpose. A loosely-related example is worse
 * than none: the model imitates its shape, and answers the example's question
 * instead of the one asked. Two is the cap for the same reason.
 */
const EXEMPLAR_FLOOR = 0.55;

export async function relevantExemplars(query: string, limit = 2): Promise<Exemplar[]> {
  const rows = getDb()
    .prepare(`SELECT id, question, answer, embedding FROM exemplars`)
    .all() as (Exemplar & { embedding: Buffer | null })[];
  if (rows.length === 0) return [];

  const qvec = await embed(query);
  if (!qvec) return []; // Without embeddings, better to show none than wrong ones.

  return rows
    .map((r) => {
      const vec = fromBlob(r.embedding);
      return { row: r, score: vec ? cosine(qvec, vec) : 0 };
    })
    .filter((r) => r.score >= EXEMPLAR_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row }) => ({ id: row.id, question: row.question, answer: row.answer }));
}

export async function exemplarBlock(query: string): Promise<string> {
  const examples = await relevantExemplars(query);
  if (examples.length === 0) return "";
  return (
    `Examples of how this user likes questions like this answered:\n\n` +
    examples
      .map((e) => `Q: ${e.question}\nA: ${e.answer}`)
      .join("\n\n")
  );
}
