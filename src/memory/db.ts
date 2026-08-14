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
export let libraryFtsAvailable = false;

/** Add a column if it is not there yet. SQLite has no IF NOT EXISTS for
 *  columns, and re-adding one throws, so the check is a read of the table
 *  shape -- cheaper than a schema-version table for a handful of additions. */
function addColumn(d: Database.Database, table: string, column: string, decl: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

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

    CREATE TABLE IF NOT EXISTS watches (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt          TEXT NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      INTEGER NOT NULL,
      last_checked_at INTEGER,
      last_report     TEXT,
      last_alerted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS watch_alerts (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      watch_id  INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
      at        INTEGER NOT NULL,
      report    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watch_alerts_watch ON watch_alerts(watch_id);

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
  // Recipes learned to be more than AppleScript, and to carry whether a person
  // has vouched for them. Both default to what the old rows already meant.
  addColumn(d, "saved_recipes", "kind", "TEXT NOT NULL DEFAULT 'applescript'");
  addColumn(d, "saved_recipes", "safe", "INTEGER NOT NULL DEFAULT 0");
  // The running summary compaction produces mid-session, kept so the final
  // session summary can cover the whole arc instead of the first 12k chars.
  addColumn(d, "sessions", "fold_summary", "TEXT");
  // Which project a conversation belonged to. A tag, not a foreign key:
  // deleting a project keeps its conversations -- the raw transcript stays
  // the source of truth whatever happens to the project folder.
  addColumn(d, "sessions", "project_id", "TEXT");
  // A task can trigger a pipeline instead of a prompt. A name, not an id:
  // pipelines are addressed by name everywhere a person types one, and the
  // lookup is re-done at run time so a deleted pipeline fails loudly.
  addColumn(d, "tasks", "pipeline", "TEXT");
  // Standing attachments scoped to one conversation: a JSON Attachment list,
  // the same shape projects use. A column rather than a table because the
  // list is small, read whole, and written whole -- and it rides the row
  // whose lifetime it shares.
  addColumn(d, "sessions", "attachments", "TEXT");

  // The scheduler lease: which process may fire cron jobs. One row, taken and
  // refreshed by a guarded UPSERT, so desktop serve and a headless daemon can
  // coexist without double-firing. Lives in the shared DB on purpose -- both
  // processes already have it open in WAL mode, and a guarded write is atomic
  // where a lock file needs a create/stat/unlink dance with races in between.
  d.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_lease (
      id  INTEGER PRIMARY KEY CHECK (id = 1),
      pid INTEGER NOT NULL,
      at  INTEGER NOT NULL
    );
  `);

  // Pipelines get their own tables rather than riding the plans table on
  // purpose: planSteps() coerces unknown step kinds to applescript and
  // runScript's fallthrough is bash, so a pipeline row leaking into that
  // machinery would execute node prompts as shell. The graph is JSON because
  // nodes carry canvas positions the server never interprets.
  d.exec(`
    CREATE TABLE IF NOT EXISTS pipelines (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      graph       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      last_run_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id           TEXT PRIMARY KEY,
      pipeline_id  TEXT NOT NULL,
      started_at   INTEGER NOT NULL,
      finished_at  INTEGER,
      status       TEXT NOT NULL DEFAULT 'running',
      node_results TEXT NOT NULL DEFAULT '[]'
    );
  `);

  // The document library. Unlike facts, these tables are wholly derived: the
  // files on disk are the source of truth, so a wipe-and-rescan is always
  // correct and reindex owns them. Paths are workspace-relative so what
  // search prints is what read_file and @mentions accept.
  d.exec(`
    CREATE TABLE IF NOT EXISTS library_docs (
      path        TEXT PRIMARY KEY,
      category    TEXT NOT NULL,
      mtime       REAL NOT NULL,
      size        INTEGER NOT NULL,
      indexed_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS library_chunks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_path    TEXT NOT NULL REFERENCES library_docs(path) ON DELETE CASCADE,
      seq         INTEGER NOT NULL,
      text        TEXT NOT NULL,
      embedding   BLOB
    );
    CREATE INDEX IF NOT EXISTS library_chunks_doc ON library_chunks(doc_path);
  `);
  try {
    d.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(
        text, content='library_chunks', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS library_ai AFTER INSERT ON library_chunks BEGIN
        INSERT INTO library_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS library_ad AFTER DELETE ON library_chunks BEGIN
        INSERT INTO library_fts(library_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS library_au AFTER UPDATE ON library_chunks BEGIN
        INSERT INTO library_fts(library_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO library_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);
    libraryFtsAvailable = true;
  } catch {
    // Same degradation as facts_fts: no FTS5, lexical search uses keyword overlap.
    libraryFtsAvailable = false;
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
