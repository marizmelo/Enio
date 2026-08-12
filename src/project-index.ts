import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { extractPdfText, looksLikePdf } from "./pdf.js";
import type { Project } from "./project.js";

const execFileAsync = promisify(execFile);

/**
 * The deterministic search index behind search_code.
 *
 * FTS5 over file text, one database per project, living in the project's own
 * dir so the cache dies with the folder. Deliberately no embeddings:
 * DECISIONS.md records the no-vector-store stance -- deterministic parsing
 * for structure, the model only for prose -- and a code search that returns
 * the same ranked locations for the same query is one the model can learn to
 * copy paths out of.
 *
 * Paths are stored alias-prefixed ("api/src/x.ts"), because the alias is how
 * every other tool addresses the file: what search prints must be what
 * read_file accepts, or the model is left translating between two path
 * languages -- exactly the kind of composition a small model fumbles.
 */

const MAX_FILE_BYTES = 512 * 1024;
const SNIPPET_CHARS = 160;
export const MAX_RESULTS = 20;

/** Re-scan at most this often; searches in between ride the last scan. The
 *  live ripgrep half of every search covers the gap for fresh writes. */
const REFRESH_MS = 5_000;

interface IndexHandle {
  db: Database.Database;
  fts: boolean;
  lastRefresh: number;
}

const handles = new Map<string, IndexHandle>();

export function indexDbPath(project: Project): string {
  return join(project.dir, "index.db");
}

function open(project: Project): IndexHandle {
  const existing = handles.get(project.id);
  if (existing) return existing;

  const db = new Database(indexDbPath(project));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path  TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      size  INTEGER NOT NULL
    );
  `);
  // What counts as indexable changed when PDFs gained text extraction, and
  // the incremental mtime check would otherwise skip every file an older
  // build already tracked as unsearchable. The index is a cache: on a
  // version bump, wipe and let the next refresh rebuild it.
  const INDEX_VERSION = 2;
  if ((db.pragma("user_version", { simple: true }) as number) < INDEX_VERSION) {
    db.exec(`DELETE FROM files;`);
    try {
      db.exec(`DELETE FROM files_fts;`);
    } catch {
      /* no FTS table in this build */
    }
    db.pragma(`user_version = ${INDEX_VERSION}`);
  }
  let fts = false;
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(path, content);`);
    fts = true;
  } catch {
    // No FTS5 in this build: searches fall back to ripgrep alone, and to a
    // plain scan when that is missing too. Degrades, never fails.
  }
  const handle = { db, fts, lastRefresh: 0 };
  handles.set(project.id, handle);
  return handle;
}

export function closeIndex(projectId: string): void {
  const handle = handles.get(projectId);
  if (handle) {
    try {
      handle.db.close();
    } catch {
      /* already closed */
    }
    handles.delete(projectId);
  }
}

/* -------------------------------------------------------- file selection */

/** Candidate files under one attached folder, relative to it. `git ls-files`
 *  when the folder is a repo -- which respects .gitignore and so keeps
 *  build output and .env secrets out of the index -- else a walk that skips
 *  the directories nobody means to search. */
async function candidatesIn(root: string): Promise<string[]> {
  if (existsSync(join(root, ".git"))) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard"],
        { cwd: root, maxBuffer: 16 * 1024 * 1024 },
      );
      return stdout.split("\n").filter(Boolean);
    } catch {
      /* git missing or hostile repo state: fall through to the walk */
    }
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  };
  walk(root);
  return out;
}

/* -------------------------------------------------------------- indexing */

export interface RefreshReport {
  files: number;
  indexed: number;
  removed: number;
}

/**
 * Bring the index up to date with what is on disk. Incremental: a file is
 * re-read only when its mtime or size changed, and rows for vanished files
 * are dropped. Cheap enough to run before a search; the throttle in
 * searchIndex keeps a burst of searches from stat-ing the tree every time.
 */
export async function refreshIndex(project: Project): Promise<RefreshReport> {
  const handle = open(project);
  const { db } = handle;

  const known = new Map<string, { mtime: number; size: number }>();
  for (const row of db.prepare(`SELECT path, mtime, size FROM files`).all() as Array<{
    path: string;
    mtime: number;
    size: number;
  }>) {
    known.set(row.path, { mtime: row.mtime, size: row.size });
  }

  const seen = new Set<string>();
  let indexed = 0;

  const upsert = db.prepare(`INSERT OR REPLACE INTO files (path, mtime, size) VALUES (?, ?, ?)`);
  const ftsDelete = handle.fts ? db.prepare(`DELETE FROM files_fts WHERE path = ?`) : null;
  const ftsInsert = handle.fts
    ? db.prepare(`INSERT INTO files_fts (path, content) VALUES (?, ?)`)
    : null;

  const indexOne = async (storedPath: string, absolute: string) => {
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      return;
    }
    seen.add(storedPath);
    const prior = known.get(storedPath);
    if (prior && prior.mtime === stat.mtimeMs && prior.size === stat.size) return;
    if (stat.size > MAX_FILE_BYTES) {
      // Tracked so the mtime check skips it next time, but never in FTS.
      upsert.run(storedPath, stat.mtimeMs, stat.size);
      ftsDelete?.run(storedPath);
      return;
    }
    let content: string | null = null;
    try {
      const head = readFileSync(absolute).subarray(0, 8192);
      if (looksLikePdf(head)) {
        // A PDF's text layer is content someone attached on purpose -- a
        // resume, a brief -- and search that cannot see it looks broken.
        // Extraction failing (or a scan with no text) degrades to tracked-
        // but-unsearchable, same as any other binary.
        content = (await extractPdfText(absolute))?.text || null;
      } else if (!head.includes(0)) {
        content = readFileSync(absolute, "utf8");
      }
    } catch {
      return;
    }
    upsert.run(storedPath, stat.mtimeMs, stat.size);
    ftsDelete?.run(storedPath);
    if (content) {
      ftsInsert?.run(storedPath, content);
      indexed++;
    }
  };

  for (const attachment of project.attachments) {
    if (attachment.kind === "file") {
      await indexOne(attachment.alias, attachment.path);
      continue;
    }
    for (const rel of await candidatesIn(attachment.path)) {
      await indexOne(join(attachment.alias, rel), join(attachment.path, rel));
    }
  }

  let removed = 0;
  const drop = db.prepare(`DELETE FROM files WHERE path = ?`);
  for (const path of known.keys()) {
    if (!seen.has(path)) {
      drop.run(path);
      ftsDelete?.run(path);
      removed++;
    }
  }

  handle.lastRefresh = Date.now();
  return { files: seen.size, indexed, removed };
}

/** Kick off the first build without holding anything up. Failures are
 *  swallowed on purpose: the index is a cache, and the live ripgrep half of
 *  search works with no index at all. */
export function buildIndexInBackground(project: Project): void {
  void refreshIndex(project).catch(() => {});
}

/* -------------------------------------------------------------- searching */

export interface SearchHit {
  /** Alias-prefixed path, exactly as read_file accepts it. */
  path: string;
  line: number;
  snippet: string;
}

function clip(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > SNIPPET_CHARS ? cleaned.slice(0, SNIPPET_CHARS) + "…" : cleaned;
}

/** FTS5 treats bare tokens as query syntax; a query wrapped as quoted phrases
 *  cannot inject operators. Mirrors the escaping facts search uses. */
function ftsQuery(query: string): string {
  const terms = query.split(/\s+/).filter(Boolean);
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

async function ripgrep(
  project: Project,
  query: string,
): Promise<{ hits: SearchHit[]; available: boolean }> {
  const hits: SearchHit[] = [];
  let available = true;
  for (const attachment of project.attachments) {
    if (attachment.kind !== "folder") continue;
    try {
      const { stdout } = await execFileAsync(
        "rg",
        ["-n", "--no-heading", "-S", "-m", String(MAX_RESULTS), "--", query],
        { cwd: attachment.path, maxBuffer: 4 * 1024 * 1024 },
      );
      for (const line of stdout.split("\n")) {
        if (!line) continue;
        const match = /^(.+?):(\d+):(.*)$/.exec(line);
        if (!match) continue;
        hits.push({
          path: join(attachment.alias, match[1]!),
          line: Number(match[2]),
          snippet: clip(match[3]!),
        });
      }
    } catch (err) {
      // Exit 1 is rg for "no matches" -- a result, not an absence. ENOENT is
      // the binary genuinely missing, which the caller uses to decide whether
      // the naive scan is needed at all.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") available = false;
    }
  }
  return { hits, available };
}

function ftsSearch(project: Project, query: string): SearchHit[] {
  const handle = open(project);
  if (!handle.fts) return [];
  let rows: Array<{ path: string; content: string }>;
  try {
    rows = handle.db
      .prepare(
        `SELECT path, content FROM files_fts WHERE files_fts MATCH ? ORDER BY bm25(files_fts) LIMIT ?`,
      )
      .all(ftsQuery(query), MAX_RESULTS) as Array<{ path: string; content: string }>;
  } catch {
    return [];
  }
  // FTS ranks files; the model needs a line. First line containing any query
  // term is honest enough for a ranked location, and cheap.
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.map((row) => {
    const lines = row.content.split("\n");
    const at = lines.findIndex((l) => {
      const lower = l.toLowerCase();
      return terms.some((t) => lower.includes(t));
    });
    const line = at >= 0 ? at + 1 : 1;
    return { path: row.path, line, snippet: clip(lines[at >= 0 ? at : 0] ?? "") };
  });
}

/** Last resort when both rg and FTS5 are unavailable: scan whatever the
 *  files table knows about, line by line. Slow and plain, but an answer. */
function naiveScan(project: Project, query: string): SearchHit[] {
  const handle = open(project);
  const lower = query.toLowerCase();
  const hits: SearchHit[] = [];
  const rows = handle.db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>;
  for (const row of rows) {
    const segments = row.path.split(sep);
    const mount = project.attachments.find((a) => a.alias === segments[0]);
    if (!mount) continue;
    const absolute =
      mount.kind === "file" ? mount.path : join(mount.path, ...segments.slice(1));
    let content: string;
    try {
      content = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.toLowerCase().includes(lower)) {
        hits.push({ path: row.path, line: i + 1, snippet: clip(lines[i]!) });
        break;
      }
    }
    if (hits.length >= MAX_RESULTS) break;
  }
  return hits;
}

/**
 * The union both halves earn their place in: ripgrep is live (sees a file
 * written seconds ago) and exact; FTS is indexed (survives rg being absent)
 * and ranked. Exact rg hits sort first. Deduped on path:line.
 */
export async function searchProject(project: Project, query: string): Promise<SearchHit[]> {
  const handle = open(project);
  if (Date.now() - handle.lastRefresh > REFRESH_MS) {
    await refreshIndex(project).catch(() => {});
  }

  const live = await ripgrep(project, query);
  const indexed = ftsSearch(project, query);
  const merged: SearchHit[] = [];
  const taken = new Set<string>();
  for (const hit of [...live.hits, ...indexed]) {
    const key = `${hit.path}:${hit.line}`;
    if (taken.has(key)) continue;
    taken.add(key);
    merged.push(hit);
    if (merged.length >= MAX_RESULTS) break;
  }
  // The naive scan exists for the machine with neither rg nor FTS5 -- an
  // empty result from working halves is an answer, not a reason to rescan.
  if (merged.length === 0 && !live.available && !handle.fts) {
    return naiveScan(project, query);
  }
  return merged;
}
