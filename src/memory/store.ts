import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { activeProject } from "../project.js";
import { cosine, fromBlob, ftsAvailable, getDb, toBlob } from "./db.js";
import { embed, embedBatch } from "./embed.js";
import { chunkTranscript, extractTriples, summarize } from "./extract.js";
import type { Triple } from "./schema.js";
import { extractSources, type Source } from "../sources.js";
import { extractArtifacts } from "../artifacts.js";
import { callDetail, callStatus } from "../tool-detail.js";

const now = () => Date.now();

/* ---------- sessions & raw log ------------------------------------------ */

export function startSession(): string {
  const id = randomUUID();
  // Stamped at creation from whichever project is open, so resuming a
  // project can find its conversations. project.ts is a leaf module; the
  // import cannot cycle.
  getDb()
    .prepare(`INSERT INTO sessions (id, started_at, project_id) VALUES (?, ?, ?)`)
    .run(id, now(), activeProject()?.id ?? null);
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

/**
 * Removes the most recent assistant message of a session -- the one a
 * guard just withdrew. The transcript is the source of truth for restore
 * AND for what the model sees next turn, so a withdrawn reply left in it
 * comes back twice: once on screen after a reload, and once as the pattern
 * the model imitates on the next question. Only the last assistant row, and
 * only when its content matches, so a race with a later message cannot
 * delete the wrong thing.
 */
export function retractLastAssistantMessage(sessionId: string, content: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT id, content FROM messages WHERE session_id = ? AND role = 'assistant'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(sessionId) as { id: number; content: string } | undefined;
  if (!row || row.content !== content) return false;
  getDb().prepare(`DELETE FROM messages WHERE id = ?`).run(row.id);
  return true;
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

/** Everything the facts table holds, for the desktop's Memory dialog. */
export function listFacts(): Array<{
  id: number;
  text: string;
  pinned: boolean;
  source: string;
  createdAt: number;
}> {
  const rows = getDb()
    .prepare(
      `SELECT id, text, pinned, source, created_at AS createdAt
         FROM facts ORDER BY pinned DESC, id DESC`,
    )
    .all() as Array<{ id: number; text: string; pinned: number; source: string; createdAt: number }>;
  return rows.map((r) => ({ ...r, pinned: r.pinned === 1 }));
}

export function setFactPinned(id: number, pinned: boolean): boolean {
  return (
    getDb().prepare(`UPDATE facts SET pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, id)
      .changes > 0
  );
}

/** The summaries feeding every turn's memory block, newest first. */
export function listSummaries(limit = 50): Array<{
  sessionId: string;
  summary: string;
  startedAt: number;
}> {
  return getDb()
    .prepare(
      `SELECT id AS sessionId, summary, started_at AS startedAt
         FROM sessions WHERE summary IS NOT NULL
        ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{ sessionId: string; summary: string; startedAt: number }>;
}

/**
 * Remove one conversation's summary (and its embedding) from the memory
 * block without touching the transcript. `indexed` stays 1 so the next
 * background indexing pass does not quietly regenerate what was just
 * forgotten — but `enio reindex` will, deliberately: summaries are derived,
 * and a full rebuild rebuilding everything is the invariant, not a leak.
 * The transcript itself is forgotten in the History dialog, not here.
 */
export function forgetSummary(sessionId: string): boolean {
  return (
    getDb()
      .prepare(`UPDATE sessions SET summary = NULL, embedding = NULL WHERE id = ? AND summary IS NOT NULL`)
      .run(sessionId).changes > 0
  );
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

/** Crude lexical overlap, used only when embeddings are unavailable.
 *  Exported for the library, which degrades the same way facts do. */
export function keywordScore(query: string, text: string): number {
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
export function toFtsQuery(raw: string): string {
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

/**
 * Keep the latest compaction summary on the session row.
 *
 * Compaction distils the early conversation into a summary and then throws it
 * away when the session ends — while the durable session summariser reads only
 * the transcript's first 12k characters, so a long session's later half never
 * reached its summary. Persisting the fold closes that: it already covers
 * everything before the recent window (re-folds fold the previous fold, so the
 * latest one spans the whole pre-window arc), and it cost nothing extra — the
 * model already wrote it. This is the save-before-compaction pass, done with
 * work compaction was doing anyway.
 */
export function saveFoldSummary(sessionId: string, summary: string): void {
  getDb()
    .prepare(`UPDATE sessions SET fold_summary = ? WHERE id = ?`)
    .run(summary.slice(0, 8000), sessionId);
}

/**
 * What the session summariser should read.
 *
 * A transcript that fits goes in whole. One that does not used to be cut at
 * 12k characters — the *first* 12k, so whatever the session ended on was
 * exactly what its summary omitted. With a fold summary available, the input
 * becomes the fold (which covers the early part) plus the transcript's tail
 * (which covers what the fold has not seen), so both ends of a long session
 * reach the summary. Without one, the old head-slice stands: a wrong-shaped
 * input beats no input.
 */
export function summaryInput(transcript: string, foldSummary: string | null): string {
  const CAP = 12000;
  if (transcript.length <= CAP || !foldSummary) return transcript.slice(0, CAP);
  return (
    `Notes on the earlier part of the conversation:\n${foldSummary}\n\n` +
    `The most recent part, verbatim:\n${transcript.slice(-(CAP - foldSummary.length - 100))}`
  );
}

/**
 * The latest indexed sessions from the last two days, newest first — recency,
 * where every other channel is similarity. "What was I doing yesterday" only
 * resembles yesterday's summary by accident; the day boundary is the actual
 * relation, and similarity search cannot express it.
 */
export function recentSummaries(limit = 3): Array<{ summary: string; startedAt: number }> {
  const cutoff = Date.now() - 48 * 3600_000;
  return getDb()
    .prepare(
      `SELECT summary, started_at AS startedAt FROM sessions
       WHERE summary IS NOT NULL AND started_at > ?
       ORDER BY started_at DESC LIMIT ?`,
    )
    .all(cutoff, limit) as Array<{ summary: string; startedAt: number }>;
}

/* ---------- retrieval for prompt injection ------------------------------ */

/**
 * Whether a question is actually about the past. A closed marker list, not a
 * judgement call: the phrases below are how people refer to earlier
 * conversations, and substring matching is the whole mechanism.
 *
 * This gate exists because summaries used to ride into EVERY turn, and a
 * summary is a record of what happened once — not, like a fact, something
 * durably true of the user. Presented ambiently the two are
 * indistinguishable to a small model, and a live handoff turn packaged last
 * week's summarised project as the current task. Facts and the graph stay
 * ambient; conversations are remembered when asked about, and the `recall`
 * tool covers the deliberate ask.
 */
const PAST_MARKERS = [
  "yesterday",
  "last time",
  "last week",
  "last month",
  "last night",
  "earlier",
  "previously",
  "previous conversation",
  "we discussed",
  "we talked",
  "we were",
  "you said",
  "you told",
  "you mentioned",
  "remind me",
  "what did we",
  "what was i",
  "where was i",
  "where did we",
  "left off",
  "recap",
  "catch me up",
  "our conversation",
] as const;

export function referencesPast(query: string): boolean {
  const q = query.toLowerCase();
  return PAST_MARKERS.some((m) => q.includes(m));
}

/**
 * Assembles the memory block prepended to the system prompt. Budgeted in
 * characters because a small model's attention is the scarce resource here —
 * a 4000-char dump of marginally-relevant history measurably degrades answers
 * compared with 800 chars of the right thing.
 */
export async function buildMemoryBlock(query: string): Promise<string> {
  const wantsPast = referencesPast(query);
  const [facts, graph, summaries] = await Promise.all([
    searchFacts(query, 8),
    searchGraph(query, 10),
    wantsPast ? searchSummaries(query, 2) : Promise.resolve([] as string[]),
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

  // Recency alongside similarity: the last two days' sessions — but only
  // when the question refers to the past at all. This channel exists because
  // "what was I doing yesterday" resembles yesterday's summary by accident
  // at best; the day boundary is the real relation, and similarity cannot
  // express it. Those questions carry the markers, so the gate keeps the
  // channel's purpose while ending the ambient drip. Deduped against the
  // similarity hits, clipped hard, and last, so the whole-block truncation
  // below cuts recency before it cuts relevance.
  const already = new Set(summaries);
  const recent = wantsPast ? recentSummaries().filter((r) => !already.has(r.summary)) : [];
  if (recent.length > 0) {
    const today = new Date().toDateString();
    sections.push(
      "Recent sessions:\n" +
        recent
          .map((r) => {
            const day = new Date(r.startedAt).toDateString() === today ? "today" : "yesterday";
            return `- (${day}) ${r.summary.slice(0, 200)}`;
          })
          .join("\n"),
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

    const fold = (
      db.prepare(`SELECT fold_summary AS f FROM sessions WHERE id = ?`).get(id) as
        | { f: string | null }
        | undefined
    )?.f ?? null;

    let summaryText = "";
    try {
      summaryText = await summarize(summaryInput(transcript, fold));
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
  /** Unpinned facts learned here — what discarding this would lose. The same
   *  count the discard dialog enumerates, surfaced up front so a conversation
   *  worth keeping can be spotted by scanning rather than by opening each. */
  knowledge: number;
  /** The project this conversation was started under, if any. A tag that
   *  outlives the project — see the migration note in db.ts. */
  projectId: string | null;
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
export function listConversations(limit = 50, projectId?: string): ConversationSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id,
              s.started_at AS startedAt,
              s.project_id AS projectId,
              MAX(m.ts)    AS lastAt,
              COUNT(m.id)  AS messages,
              (SELECT content FROM messages
                WHERE session_id = s.id AND role = 'user'
                ORDER BY ts ASC LIMIT 1) AS firstUser,
              (SELECT COUNT(*) FROM facts
                WHERE session_id = s.id AND pinned = 0) AS knowledge
         FROM sessions s
         JOIN messages m ON m.session_id = s.id
        WHERE (? IS NULL OR s.project_id = ?)
        GROUP BY s.id
        ORDER BY lastAt DESC
        LIMIT ?`,
    )
    .all(projectId ?? null, projectId ?? null, limit) as Array<{
    id: string;
    startedAt: number;
    projectId: string | null;
    lastAt: number;
    messages: number;
    firstUser: string | null;
    knowledge: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    title: (r.firstUser ?? "(no user message)").replace(/\s+/g, " ").trim().slice(0, 80),
    startedAt: r.startedAt,
    lastAt: r.lastAt,
    messages: r.messages,
    knowledge: r.knowledge,
    projectId: r.projectId,
  }));
}

/** The most recently active conversation of a project, for resume-on-open.
 *  Activity, not creation: the conversation someone left off in is the one
 *  reopening the project should surface. */
export function latestSessionForProject(projectId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT s.id, MAX(m.ts) AS lastAt
         FROM sessions s
         JOIN messages m ON m.session_id = s.id
        WHERE s.project_id = ?
        GROUP BY s.id
        ORDER BY lastAt DESC
        LIMIT 1`,
    )
    .get(projectId) as { id: string } | undefined;
  return row?.id ?? null;
}

export interface StoredMessage {
  role: string;
  content: string;
  ts: number;
  /** Tools this reply ran, in order, repeats included. */
  tools?: string[];
  /** The same calls, with what each one was and how it went. */
  calls?: Array<{ name: string; detail: string; status: string }>;
  /** Pages those tools read, grouped by the tool that read them. */
  sources?: Array<{ tool: string; items: Source[] }>;
  /** Which agent answered — restored from the trace, "single" rows skipped. */
  agent?: string;
  /** Where the answer's substance came from, as the harness recorded it. */
  basis?: "web" | "files" | "memory" | "conversation" | "model";
  /** Files this reply created, recovered from its tools' own output — the
   *  same extraction that opens the canvas live. */
  artifacts?: Array<{ type: string; path: string }>;
}

/**
 * The transcript, oldest first, for restoring a conversation into a client.
 *
 * The reply is in `messages`; what produced it is in the trace. Restoring only
 * the text made a resumed conversation quietly poorer than a live one -- the
 * tool badges and the list of pages read were on screen a moment before the
 * restart and gone after it, which reads as the app having lost them rather
 * than as never having stored them.
 *
 * Reconstructed from `turn_steps` rather than by adding columns here. The
 * trace already records every tool call with its arguments and its output, so
 * a new column would be a second copy of that, kept in step by hand; deriving
 * instead means conversations recorded before any of this existed come back
 * with their badges too. It also holds the invariant that raw records are the
 * source of truth and everything else is derived.
 */
export function conversationMessages(sessionId: string): StoredMessage[] {
  const db = getDb();
  const messages = db
    .prepare(
      `SELECT role, content, ts FROM messages
        WHERE session_id = ? ORDER BY ts ASC, id ASC`,
    )
    .all(sessionId) as StoredMessage[];

  let steps: Array<{ startedAt: number; kind: string; name: string; args: string; output: string }>;
  let routed: Array<{ startedAt: number; specialist: string }>;
  try {
    steps = db
      .prepare(
        `SELECT t.started_at AS startedAt, s.kind, s.name, s.args, s.output
           FROM turns t JOIN turn_steps s ON s.turn_id = t.id
          WHERE t.session_id = ? AND s.kind IN ('tool', 'harness') AND s.name IS NOT NULL
          ORDER BY t.started_at ASC, s.seq ASC`,
      )
      .all(sessionId) as typeof steps;
    // 'single' is the no-routing marker, not an agent; skipping it here is
    // what keeps single-agent mode from growing a meaningless chip.
    routed = db
      .prepare(
        `SELECT started_at AS startedAt, specialist FROM turns
          WHERE session_id = ? AND specialist != 'single'
          ORDER BY started_at ASC`,
      )
      .all(sessionId) as typeof routed;
  } catch {
    // Losing decoration must never cost the transcript, which is the same rule
    // recordTurn follows in the other direction.
    return messages;
  }
  if (steps.length === 0 && routed.length === 0) return messages;

  // Matched by time rather than by counting turns off against replies. A turn
  // whose trace insert failed would shift every later pairing by one, and
  // silently attaching one reply's tools to another is worse than showing
  // none: it is a wrong answer to "where did this come from".
  const assistants = messages.filter((m) => m.role === "assistant");
  for (const turn of routed) {
    const target = assistants.find((m) => m.ts >= turn.startedAt);
    if (target && !target.agent) target.agent = turn.specialist;
  }
  for (const step of steps) {
    const target = assistants.find((m) => m.ts >= step.startedAt);
    if (!target) continue;
    // A harness step is not a tool the model ran: no badge, no sources —
    // a restored reply must not grow a chip its live rendering never had.
    // Its artifact still rides below, which is the whole reason it is here.
    // The basis chip is the one harness step that DOES draw something: it
    // is provenance the live rendering had, so restore must carry it too.
    if (step.kind === "harness" && step.name === "basis") {
      try {
        const b = (JSON.parse(step.args || "{}") as { basis?: string }).basis;
        if (b === "web" || b === "files" || b === "memory" || b === "conversation" || b === "model") {
          target.basis = b;
        }
      } catch {
        /* an unreadable basis leaves the reply unlabelled, never mislabelled */
      }
    }
    if (step.kind !== "harness") {
      (target.tools ??= []).push(step.name);

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(step.args || "{}");
      } catch {
        /* an unparseable argument record still leaves the tool name usable */
      }
      // What the call actually was, so a reopened conversation can answer
      // "which command, and did it work" exactly as the live one did.
      (target.calls ??= []).push({
        name: step.name,
        detail: callDetail(step.name, args),
        status: callStatus(step.output ?? ""),
      });
      const items = extractSources(step.name, args, step.output ?? "");
      if (items.length > 0) (target.sources ??= []).push({ tool: step.name, items });
    }

    // What the reply created rides with it, so a restored conversation keeps
    // the click-to-open chips a live one has.
    for (const made of extractArtifacts(step.name, step.output ?? "")) {
      if (!made.path) continue;
      const list = (target.artifacts ??= []);
      if (!list.some((a) => a.path === made.path)) {
        list.push({ type: made.type, path: made.path });
      }
    }
  }

  return messages;
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
