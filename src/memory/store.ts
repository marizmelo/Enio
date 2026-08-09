import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { cosine, fromBlob, ftsAvailable, getDb, toBlob } from "./db.js";
import { embed, embedBatch } from "./embed.js";
import { chunkTranscript, extractTriples, summarize } from "./extract.js";
import type { Triple } from "./schema.js";

const now = () => Date.now();

/* ---------- sessions & raw log ------------------------------------------ */

export function startSession(): string {
  const id = randomUUID();
  getDb()
    .prepare(`INSERT INTO sessions (id, started_at) VALUES (?, ?)`)
    .run(id, now());
  return id;
}

export function logMessage(sessionId: string, role: string, content: string): void {
  if (!content.trim()) return;
  getDb()
    .prepare(
      `INSERT INTO messages (session_id, role, content, ts) VALUES (?, ?, ?, ?)`,
    )
    .run(sessionId, role, content, now());
}

export function endSession(sessionId: string): void {
  getDb().prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(now(), sessionId);
}

export function transcriptOf(sessionId: string): string {
  const rows = getDb()
    .prepare(
      `SELECT role, content FROM messages
       WHERE session_id = ? AND role IN ('user','assistant')
       ORDER BY id`,
    )
    .all(sessionId) as { role: string; content: string }[];
  return rows.map((r) => `${r.role}: ${r.content}`).join("\n");
}

/* ---------- explicit facts (the remember/recall tools) ------------------ */

export async function rememberFact(
  text: string,
  opts: { pinned?: boolean; sessionId?: string; source?: string } = {},
): Promise<{ stored: boolean; reason?: string }> {
  const clean = text.trim();
  if (clean.length < 3) return { stored: false, reason: "too short" };

  const db = getDb();
  const existing = db.prepare(`SELECT id FROM facts WHERE text = ?`).get(clean);
  if (existing) return { stored: false, reason: "already known" };

  const vec = await embed(clean);
  db.prepare(
    `INSERT INTO facts (text, embedding, pinned, source, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    clean,
    vec ? toBlob(vec) : null,
    opts.pinned ? 1 : 0,
    opts.source ?? "tool",
    opts.sessionId ?? null,
    now(),
  );
  return { stored: true };
}

export function forgetFact(idOrText: string): boolean {
  const db = getDb();
  const asId = Number(idOrText);
  const result = Number.isFinite(asId)
    ? db.prepare(`DELETE FROM facts WHERE id = ?`).run(asId)
    : db.prepare(`DELETE FROM facts WHERE text = ?`).run(idOrText);
  return result.changes > 0;
}

export interface ScoredFact {
  id: number;
  text: string;
  score: number;
  pinned: boolean;
}

export async function searchFacts(query: string, limit = 8): Promise<ScoredFact[]> {
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, text, embedding, pinned FROM facts`)
    .all() as { id: number; text: string; embedding: Buffer | null; pinned: number }[];
  if (rows.length === 0) return [];

  const qvec = await embed(query);
  const threshold = modeFor(qvec).fact;
  const scored: ScoredFact[] = rows.map((r) => {
    const vec = fromBlob(r.embedding);
    let score = 0;
    if (qvec && vec) score = cosine(qvec, vec);
    else score = keywordScore(query, r.text);
    return { id: r.id, text: r.text, score, pinned: r.pinned === 1 };
  });

  // Pinned facts bypass ranking entirely — they're identity, not retrieval.
  const pinned = scored.filter((f) => f.pinned);
  const rest = scored
    .filter((f) => !f.pinned && f.score > threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit - pinned.length));

  return [...pinned, ...rest];
}

/**
 * Relevance cutoffs, per scoring mode.
 *
 * These are NOT interchangeable. Cosine over normalised embeddings puts loosely
 * related text around 0.3-0.5, so 0.25 is a permissive floor. Lexical overlap is
 * a ratio of matched query terms, where a single meaningful match out of five
 * words scores 0.2 and is often exactly the row you wanted. Sharing one constant
 * between the two makes keyword fallback silently return nothing.
 */
const THRESHOLDS = {
  semantic: { fact: 0.25, entity: 0.3, summary: 0.3 },
  lexical: { fact: 0.15, entity: 0.15, summary: 0.15 },
} as const;

const modeFor = (qvec: Float32Array | null) =>
  qvec ? THRESHOLDS.semantic : THRESHOLDS.lexical;

/** Crude lexical overlap, used only when embeddings are unavailable. */
function keywordScore(query: string, text: string): number {
  const q = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  if (q.size === 0) return 0;
  const t = new Set(text.toLowerCase().split(/\W+/));
  let hits = 0;
  for (const w of q) if (t.has(w)) hits++;
  return hits / q.size;
}

export function searchFactsKeyword(query: string, limit = 8): ScoredFact[] {
  const db = getDb();
  if (ftsAvailable) {
    try {
      const rows = db
        .prepare(
          `SELECT f.id, f.text, f.pinned, bm25(facts_fts) AS rank
           FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
           WHERE facts_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(toFtsQuery(query), limit) as any[];
      return rows.map((r) => ({
        id: r.id, text: r.text, score: 1 / (1 + Math.abs(r.rank)), pinned: r.pinned === 1,
      }));
    } catch {
      /* malformed FTS query — fall through to LIKE */
    }
  }
  const rows = db
    .prepare(`SELECT id, text, pinned FROM facts WHERE text LIKE ? LIMIT ?`)
    .all(`%${query}%`, limit) as any[];
  return rows.map((r) => ({ id: r.id, text: r.text, score: 0.5, pinned: r.pinned === 1 }));
}

/** FTS5 treats plenty of punctuation as syntax; quote each term to be safe. */
function toFtsQuery(raw: string): string {
  const terms = raw.split(/\W+/).filter((w) => w.length > 1);
  return terms.length ? terms.map((t) => `"${t}"`).join(" OR ") : `"${raw}"`;
}

/* ---------- graph ------------------------------------------------------- */

function upsertEntity(name: string, type: string): number {
  const db = getDb();
  const ts = now();
  db.prepare(
    `INSERT INTO entities (name, type, first_seen, last_seen)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name, type) DO UPDATE SET
       mentions = mentions + 1,
       last_seen = excluded.last_seen`,
  ).run(name, type, ts, ts);
  const row = db
    .prepare(`SELECT id FROM entities WHERE name = ? AND type = ?`)
    .get(name, type) as { id: number };
  return row.id;
}

export function applyTriples(triples: Triple[], sessionId: string): number {
  const db = getDb();
  const ts = now();
  let applied = 0;

  const tx = db.transaction((batch: Triple[]) => {
    for (const t of batch) {
      const src = upsertEntity(t.subject, t.subject_type);
      const dst = upsertEntity(t.object, t.object_type);

      // Seeing the same claim again is the only evidence of correctness we have
      // from a single weak extractor, so repetition is what raises confidence.
      db.prepare(
        `INSERT INTO edges (src, rel, dst, confidence, session_id, valid_from)
         VALUES (?, ?, ?, 0.5, ?, ?)
         ON CONFLICT(src, rel, dst) DO UPDATE SET
           confidence = MIN(0.99, confidence + 0.15),
           valid_to = NULL,
           session_id = excluded.session_id`,
      ).run(src, t.relation, dst, sessionId, ts);
      applied++;
    }
  });

  tx(triples);
  return applied;
}

export interface GraphHit {
  subject: string;
  relation: string;
  object: string;
  confidence: number;
}

/** Entity lookup plus one-hop expansion. Two hops was tried and mostly surfaced
 *  noise — with a small graph the second hop is rarely relevant to the query. */
export async function searchGraph(query: string, limit = 12): Promise<GraphHit[]> {
  const db = getDb();
  const entities = db
    .prepare(`SELECT id, name, type, embedding FROM entities`)
    .all() as { id: number; name: string; type: string; embedding: Buffer | null }[];
  if (entities.length === 0) return [];

  const qvec = await embed(query);
  const ranked = entities
    .map((e) => {
      const vec = fromBlob(e.embedding);
      const score = qvec && vec ? cosine(qvec, vec) : keywordScore(query, e.name);
      return { ...e, score };
    })
    .filter((e) => e.score > modeFor(qvec).entity)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (ranked.length === 0) return [];

  const ids = ranked.map((e) => e.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT s.name AS subject, e.rel AS relation, o.name AS object, e.confidence
       FROM edges e
       JOIN entities s ON s.id = e.src
       JOIN entities o ON o.id = e.dst
       WHERE (e.src IN (${placeholders}) OR e.dst IN (${placeholders}))
         AND e.valid_to IS NULL
       ORDER BY e.confidence DESC
       LIMIT ?`,
    )
    .all(...ids, ...ids, limit) as GraphHit[];

  return rows;
}

export async function searchSummaries(query: string, limit = 3): Promise<string[]> {
  const db = getDb();
  const rows = db
    .prepare(`SELECT summary, embedding FROM sessions WHERE summary IS NOT NULL`)
    .all() as { summary: string; embedding: Buffer | null }[];
  if (rows.length === 0) return [];

  const qvec = await embed(query);
  return rows
    .map((r) => {
      const vec = fromBlob(r.embedding);
      const score = qvec && vec ? cosine(qvec, vec) : keywordScore(query, r.summary);
      return { summary: r.summary, score };
    })
    .filter((r) => r.score > modeFor(qvec).summary)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.summary);
}

/* ---------- retrieval for prompt injection ------------------------------ */

/**
 * Assembles the memory block prepended to the system prompt. Budgeted in
 * characters because a small model's attention is the scarce resource here —
 * a 4000-char dump of marginally-relevant history measurably degrades answers
 * compared with 800 chars of the right thing.
 */
export async function buildMemoryBlock(query: string): Promise<string> {
  const [facts, graph, summaries] = await Promise.all([
    searchFacts(query, 8),
    searchGraph(query, 10),
    searchSummaries(query, 2),
  ]);

  const sections: string[] = [];

  if (facts.length > 0) {
    sections.push(
      "Known facts:\n" + facts.map((f) => `- ${f.text}`).join("\n"),
    );
  }
  if (graph.length > 0) {
    sections.push(
      "Related knowledge:\n" +
        graph
          .map((g) => `- ${g.subject} ${g.relation.toLowerCase().replace(/_/g, " ")} ${g.object}`)
          .join("\n"),
    );
  }
  if (summaries.length > 0) {
    sections.push(
      "Earlier conversations:\n" + summaries.map((s) => `- ${s}`).join("\n"),
    );
  }

  if (sections.length === 0) return "";
  let block = sections.join("\n\n");
  if (block.length > config.memoryBlockChars) {
    block = block.slice(0, config.memoryBlockChars) + "\n[...truncated]";
  }
  return `<memory>\n${block}\n</memory>`;
}

/* ---------- the batch indexer ------------------------------------------ */

export interface IndexReport {
  sessions: number;
  triples: number;
  summaries: number;
}

/**
 * Processes every unindexed session: summarise, extract, embed. Safe to
 * interrupt — each session is committed independently and `indexed` only flips
 * once its work is durable.
 */
export async function indexPending(
  onProgress?: (msg: string) => void,
): Promise<IndexReport> {
  const db = getDb();
  const pending = db
    .prepare(
      `SELECT id FROM sessions
       WHERE indexed = 0 AND id IN (SELECT DISTINCT session_id FROM messages)
       ORDER BY started_at`,
    )
    .all() as { id: string }[];

  const report: IndexReport = { sessions: 0, triples: 0, summaries: 0 };

  for (const { id } of pending) {
    const transcript = transcriptOf(id);
    if (transcript.trim().length < 40) {
      db.prepare(`UPDATE sessions SET indexed = 1 WHERE id = ?`).run(id);
      continue;
    }

    onProgress?.(`indexing session ${id.slice(0, 8)} (${transcript.length} chars)`);

    let summaryText = "";
    try {
      summaryText = await summarize(transcript.slice(0, 12000));
      const vec = await embed(summaryText);
      db.prepare(`UPDATE sessions SET summary = ?, embedding = ? WHERE id = ?`).run(
        summaryText,
        vec ? toBlob(vec) : null,
        id,
      );
      report.summaries++;
    } catch (err) {
      onProgress?.(`  summary failed: ${(err as Error).message}`);
    }

    for (const chunk of chunkTranscript(transcript)) {
      try {
        const triples = await extractTriples(chunk);
        if (triples.length > 0) {
          report.triples += applyTriples(triples, id);
          onProgress?.(`  +${triples.length} triples`);
        }
      } catch (err) {
        onProgress?.(`  extraction failed: ${(err as Error).message}`);
      }
    }

    await backfillEntityEmbeddings();
    db.prepare(`UPDATE sessions SET indexed = 1 WHERE id = ?`).run(id);
    report.sessions++;
  }

  return report;
}

/** Entities are created inside a synchronous transaction, so their embeddings
 *  are computed afterwards in one batch. */
async function backfillEntityEmbeddings(): Promise<void> {
  const db = getDb();
  const missing = db
    .prepare(`SELECT id, name, type FROM entities WHERE embedding IS NULL LIMIT 256`)
    .all() as { id: number; name: string; type: string }[];
  if (missing.length === 0) return;

  const vecs = await embedBatch(missing.map((e) => `${e.name} (${e.type})`));
  const update = db.prepare(`UPDATE entities SET embedding = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    missing.forEach((e, i) => {
      const v = vecs[i];
      if (v) update.run(toBlob(v), e.id);
    });
  });
  tx();
}

/** Throw away the derived graph and summaries, keeping the raw log, so
 *  everything can be rebuilt — including with a better extraction model. */
export function resetDerived(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM edges;
    DELETE FROM entities;
    UPDATE sessions SET indexed = 0, summary = NULL, embedding = NULL;
  `);
}

export interface MemoryStats {
  sessions: number;
  messages: number;
  facts: number;
  entities: number;
  edges: number;
  unindexed: number;
}

export function stats(): MemoryStats {
  const db = getDb();
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    sessions: one(`SELECT COUNT(*) AS n FROM sessions`),
    messages: one(`SELECT COUNT(*) AS n FROM messages`),
    facts: one(`SELECT COUNT(*) AS n FROM facts`),
    entities: one(`SELECT COUNT(*) AS n FROM entities`),
    edges: one(`SELECT COUNT(*) AS n FROM edges`),
    unindexed: one(`SELECT COUNT(*) AS n FROM sessions WHERE indexed = 0`),
  };
}

/* ---------- conversations ------------------------------------------------ */

export interface ConversationSummary {
  id: string;
  title: string;
  startedAt: number;
  lastAt: number;
  messages: number;
}

/**
 * Stored conversations, newest activity first.
 *
 * Empty sessions are filtered out rather than deleted: every server boot and
 * every "new chat" opens a session speculatively, and a list that shows each
 * of those as an untitled row would bury the conversations that matter.
 *
 * The title is the first user message rather than a stored column, so it can
 * never disagree with the transcript it names.
 */
export function listConversations(limit = 50): ConversationSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id,
              s.started_at AS startedAt,
              MAX(m.ts)    AS lastAt,
              COUNT(m.id)  AS messages,
              (SELECT content FROM messages
                WHERE session_id = s.id AND role = 'user'
                ORDER BY ts ASC LIMIT 1) AS firstUser
         FROM sessions s
         JOIN messages m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY lastAt DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    startedAt: number;
    lastAt: number;
    messages: number;
    firstUser: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    title: (r.firstUser ?? "(no user message)").replace(/\s+/g, " ").trim().slice(0, 80),
    startedAt: r.startedAt,
    lastAt: r.lastAt,
    messages: r.messages,
  }));
}

/** The transcript, oldest first, for restoring a conversation into a client. */
export function conversationMessages(
  sessionId: string,
): Array<{ role: string; content: string; ts: number }> {
  return getDb()
    .prepare(
      `SELECT role, content, ts FROM messages
        WHERE session_id = ? ORDER BY ts ASC, id ASC`,
    )
    .all(sessionId) as Array<{ role: string; content: string; ts: number }>;
}

/**
 * What was learned from a conversation: the facts that would lose their
 * backing transcript if it were discarded.
 *
 * Only unpinned facts are listed. A pinned fact already stands on its own —
 * that is what pinning means, and it is how `enio remember` works — so
 * discarding the transcript does not endanger it.
 */
export function conversationKnowledge(
  sessionId: string,
): Array<{ id: number; text: string }> {
  return getDb()
    .prepare(
      `SELECT id, text FROM facts
        WHERE session_id = ? AND pinned = 0 ORDER BY id ASC`,
    )
    .all(sessionId) as Array<{ id: number; text: string }>;
}

/**
 * Delete a conversation, deciding the fate of what was learned from it.
 *
 * The invariant this protects: transcripts are the source of truth and
 * everything else is derived. A fact whose transcript is gone cannot survive
 * `enio reindex`, so leaving it unpinned would be a silent deletion deferred
 * to whenever someone next reindexes. The two honest options are to promote
 * it to pinned — the same transcript-free standing `enio remember` grants —
 * or to delete it now, visibly.
 *
 * Edges and traces from the session go with the transcript in both cases:
 * they are derived and rebuildable by definition, and keeping graph edges
 * whose evidence is deleted would make the graph assert things nothing can
 * substantiate.
 */
export function discardConversation(
  sessionId: string,
  opts: { keepFacts: boolean },
): { deletedMessages: number; facts: number } {
  const db = getDb();
  const facts = conversationKnowledge(sessionId).length;

  const run = db.transaction(() => {
    if (opts.keepFacts) {
      db.prepare(
        `UPDATE facts SET pinned = 1, source = 'kept-on-discard'
          WHERE session_id = ? AND pinned = 0`,
      ).run(sessionId);
    } else {
      db.prepare(`DELETE FROM facts WHERE session_id = ? AND pinned = 0`).run(sessionId);
    }

    db.prepare(`DELETE FROM edges WHERE session_id = ?`).run(sessionId);
    db.prepare(
      `DELETE FROM turn_steps WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?)`,
    ).run(sessionId);
    db.prepare(`DELETE FROM turns WHERE session_id = ?`).run(sessionId);

    const deleted = db
      .prepare(`DELETE FROM messages WHERE session_id = ?`)
      .run(sessionId).changes;
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    return deleted;
  });

  return { deletedMessages: run(), facts };
}
