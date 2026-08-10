import { getDb } from "./db.js";

/**
 * Turn-level tracing.
 *
 * Separate from `messages`, which is the conversational record. This is the
 * diagnostic record: what the model was actually shown, what it emitted before
 * anything was cleaned up, and which repairs fired.
 *
 * That distinction matters because the interesting failures with a small model
 * are invisible in the conversation. A turn where the tool call had to be
 * scavenged out of plain text and the JSON repaired reads identically to a
 * clean one once it's finished — but a run of them means the prompt is
 * confusing the model, and you can only see that if it was recorded.
 *
 * Generic LLM observability can't capture this: it sees prompt-in/completion-out
 * and has no concept of which memories were retrieved or which specialist was
 * chosen.
 */

export interface StepRecord {
  seq: number;
  kind: "model" | "tool";
  name?: string | null;
  args?: string | null;
  output?: string | null;
  rawContent?: string | null;
  reasoning?: string | null;
  repaired?: boolean;
  scavenged?: boolean;
  durationMs?: number;
  error?: string | null;
}

export interface TurnRecord {
  sessionId: string;
  question: string;
  reply: string;
  specialist: string;
  systemPrompt: string;
  memoryBlock: string;
  startedAt: number;
  durationMs: number;
  iterations: number;
  steps: StepRecord[];
}

/** Tool output can be huge; a trace database shouldn't grow without bound. */
const MAX_FIELD = 20_000;
const clip = (s: string | null | undefined): string | null =>
  s == null ? null : s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + "\n[...truncated]" : s;

/**
 * The specialist that handled this conversation's last routed turn, or null.
 *
 * Read for sticky routing: a short follow-up ("try again", "go ahead")
 * continues the conversation it is in rather than resetting to the default
 * specialist. 'single' rows are skipped — that is the no-routing marker, not a
 * specialist. Failure returns null for the same reason recordTurn is wrapped:
 * tracing must never decide whether a turn happens, in either direction.
 */
export function lastSpecialist(sessionId: string): string | null {
  try {
    const row = getDb()
      .prepare(
        `SELECT specialist FROM turns
          WHERE session_id = ? AND specialist != 'single'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId) as { specialist: string } | undefined;
    return row?.specialist ?? null;
  } catch {
    return null;
  }
}

export function recordTurn(turn: TurnRecord): number {
  const db = getDb();

  const insert = db.transaction((t: TurnRecord) => {
    const result = db
      .prepare(
        `INSERT INTO turns
           (session_id, question, reply, specialist, system_prompt, memory_block,
            started_at, duration_ms, iterations)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.sessionId,
        clip(t.question) ?? "",
        clip(t.reply) ?? "",
        t.specialist,
        clip(t.systemPrompt) ?? "",
        clip(t.memoryBlock) ?? "",
        t.startedAt,
        t.durationMs,
        t.iterations,
      );

    const turnId = Number(result.lastInsertRowid);
    const step = db.prepare(
      `INSERT INTO turn_steps
         (turn_id, seq, kind, name, args, output, raw_content, reasoning,
          repaired, scavenged, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of t.steps) {
      step.run(
        turnId,
        s.seq,
        s.kind,
        s.name ?? null,
        clip(s.args),
        clip(s.output),
        clip(s.rawContent),
        clip(s.reasoning),
        s.repaired ? 1 : 0,
        s.scavenged ? 1 : 0,
        s.durationMs ?? 0,
        s.error ?? null,
      );
    }
    return turnId;
  });

  return insert(turn);
}

/* ---------- read side, for the inspector ------------------------------- */

export interface SessionSummary {
  id: string;
  startedAt: number;
  endedAt: number | null;
  summary: string | null;
  turnCount: number;
}

export function listSessions(limit = 100): SessionSummary[] {
  return getDb()
    .prepare(
      `SELECT s.id,
              s.started_at AS startedAt,
              s.ended_at   AS endedAt,
              s.summary,
              (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turnCount
       FROM sessions s
       WHERE EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id)
       ORDER BY s.started_at DESC
       LIMIT ?`,
    )
    .all(limit) as SessionSummary[];
}

export function turnsForSession(sessionId: string): unknown[] {
  const db = getDb();
  const turns = db
    .prepare(
      `SELECT id, session_id AS sessionId, question, reply, specialist,
              system_prompt AS systemPrompt, memory_block AS memoryBlock,
              started_at AS startedAt, duration_ms AS durationMs, iterations
       FROM turns WHERE session_id = ? ORDER BY id`,
    )
    .all(sessionId) as Record<string, unknown>[];

  const steps = db.prepare(
    `SELECT seq, kind, name, args, output,
            raw_content AS rawContent, reasoning,
            repaired, scavenged, duration_ms AS durationMs, error
     FROM turn_steps WHERE turn_id = ? ORDER BY seq`,
  );

  return turns.map((t) => ({
    ...t,
    steps: (steps.all(t.id) as Record<string, unknown>[]).map((s) => ({
      ...s,
      // SQLite has no boolean type; the UI expects real ones.
      repaired: s.repaired === 1,
      scavenged: s.scavenged === 1,
    })),
  }));
}

export interface GraphView {
  nodes: { id: number; name: string; type: string; mentions: number }[];
  edges: {
    id: number;
    source: number;
    target: number;
    relation: string;
    confidence: number;
  }[];
}

/**
 * Most-mentioned entities first, then every edge between the ones returned.
 * Taking the top N entities and *then* filtering edges — rather than taking
 * the top N edges — avoids dangling references to nodes that were cut.
 */
export function graphView(limit = 300): GraphView {
  const db = getDb();
  const nodes = db
    .prepare(
      `SELECT id, name, type, mentions FROM entities
       ORDER BY mentions DESC, id LIMIT ?`,
    )
    .all(limit) as GraphView["nodes"];

  if (nodes.length === 0) return { nodes: [], edges: [] };

  const ids = nodes.map((n) => n.id);
  const placeholders = ids.map(() => "?").join(",");
  const edges = db
    .prepare(
      `SELECT id, src AS source, dst AS target, rel AS relation, confidence
       FROM edges
       WHERE src IN (${placeholders}) AND dst IN (${placeholders})
         AND valid_to IS NULL`,
    )
    .all(...ids, ...ids) as GraphView["edges"];

  return { nodes, edges };
}

export function deleteEdge(id: number): boolean {
  return getDb().prepare(`DELETE FROM edges WHERE id = ?`).run(id).changes > 0;
}

/** Foreign keys are ON with CASCADE, so this removes the entity's edges too. */
export function deleteEntity(id: number): boolean {
  return getDb().prepare(`DELETE FROM entities WHERE id = ?`).run(id).changes > 0;
}

export function turnCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM turns`).get() as { n: number }).n;
}
