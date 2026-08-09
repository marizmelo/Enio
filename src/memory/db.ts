import Database from "better-sqlite3";
import { dbPath, ensureDirs } from "../config.js";

/**
 * Schema notes
 *
 * `messages` is the source of truth and is never derived from anything. The
 * graph (`entities` + `edges`) and `sessions.summary` are *derived indexes* —
 * built by asking Maple to extract structure, which it does imperfectly. Keeping
 * the raw log means a bad extraction is never destructive: `enio reindex`
 * rebuilds the graph from scratch, including with a better model later.
 *
 * Edges carry `valid_to` rather than being deleted when superseded. "Mariz uses
 * Hyper" doesn't stop being a true statement about the past when it stops being
 * true about the present, and a memory that silently rewrites history is worse
 * than one that forgets.
 */

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  ensureDirs();
  db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** FTS5 is absent from some SQLite builds (notably node:sqlite on macOS). We use
 *  better-sqlite3, which bundles it, but verify rather than assume. */
export let ftsAvailable = false;

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      summary     TEXT,
      embedding   BLOB,
      indexed     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      ts          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    CREATE TABLE IF NOT EXISTS entities (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      embedding   BLOB,
      mentions    INTEGER NOT NULL DEFAULT 1,
      first_seen  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      UNIQUE(name, type)
    );

    CREATE TABLE IF NOT EXISTS edges (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      src         INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      rel         TEXT NOT NULL,
      dst         INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      confidence  REAL NOT NULL DEFAULT 0.5,
      session_id  TEXT,
      valid_from  INTEGER NOT NULL,
      valid_to    INTEGER,
      UNIQUE(src, rel, dst)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);

    CREATE TABLE IF NOT EXISTS preferences (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      text        TEXT NOT NULL UNIQUE,
      created_at  INTEGER NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS exemplars (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      question    TEXT NOT NULL UNIQUE,
      answer      TEXT NOT NULL,
      embedding   BLOB,
      created_at  INTEGER NOT NULL
    );

    -- Diagnostic record, distinct from the messages table (the conversational
    -- record). Captures what the model was shown and what it emitted before
    -- any repair, which is where small-model failures are visible.
    CREATE TABLE IF NOT EXISTS turns (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      question      TEXT NOT NULL,
      reply         TEXT NOT NULL DEFAULT '',
      specialist    TEXT NOT NULL DEFAULT 'single',
      system_prompt TEXT NOT NULL DEFAULT '',
      memory_block  TEXT NOT NULL DEFAULT '',
      started_at    INTEGER NOT NULL,
      duration_ms   INTEGER NOT NULL DEFAULT 0,
      iterations    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);

    CREATE TABLE IF NOT EXISTS turn_steps (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id     INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      seq         INTEGER NOT NULL,
      kind        TEXT NOT NULL,
      name        TEXT,
      args        TEXT,
      output      TEXT,
      raw_content TEXT,
      reasoning   TEXT,
      repaired    INTEGER NOT NULL DEFAULT 0,
      scavenged   INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_steps_turn ON turn_steps(turn_id);

    -- Scheduled work. Each run produces a normal turn, so task output is
    -- traceable in the inspector exactly like a conversation.
    CREATE TABLE IF NOT EXISTS tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL UNIQUE,
      prompt       TEXT NOT NULL,
      schedule     TEXT NOT NULL,
      specialist   TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL,
      last_run_at  INTEGER,
      last_status  TEXT,
      last_error   TEXT
    );

    CREATE TABLE IF NOT EXISTS task_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      started_at  INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL,
      output      TEXT,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id);

    CREATE TABLE IF NOT EXISTS plans (
      id          TEXT PRIMARY KEY,
      session_id  TEXT,
      summary     TEXT NOT NULL,
      kind        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      result      TEXT,
      created_at  INTEGER NOT NULL,
      decided_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);

    CREATE TABLE IF NOT EXISTS saved_recipes (
      name        TEXT PRIMARY KEY,
      summary     TEXT NOT NULL,
      script      TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS facts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      text        TEXT NOT NULL UNIQUE,
      embedding   BLOB,
      pinned      INTEGER NOT NULL DEFAULT 0,
      source      TEXT NOT NULL DEFAULT 'tool',
      session_id  TEXT,
      created_at  INTEGER NOT NULL
    );
  `);

  try {
    d.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        text, content='facts', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO facts_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);
    ftsAvailable = true;
  } catch {
    // No FTS5 in this build. searchFactsKeyword() degrades to LIKE.
    ftsAvailable = false;
  }
}

/* ---------- vector helpers ---------------------------------------------- */

/** Embeddings are stored as raw float32 blobs. At personal scale (low tens of
 *  thousands of rows) brute-force cosine in JS is a few milliseconds, which is
 *  well worth not depending on a vector extension that may not compile. */
export function toBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function fromBlob(buf: Buffer | Uint8Array | null): Float32Array | null {
  if (!buf || buf.byteLength === 0) return null;
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/** Inputs are L2-normalised at embed time, so this is a plain dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function closeDb(): void {
  db?.close();
  db = null;
}
