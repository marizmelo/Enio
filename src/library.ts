import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { config } from "./config.js";
import { cosine, fromBlob, getDb, libraryFtsAvailable, toBlob } from "./memory/db.js";
import { embed, embedBatch } from "./memory/embed.js";
import { chunkTranscript } from "./memory/extract.js";
import { keywordScore, toFtsQuery } from "./memory/store.js";
import { extractPdfText, looksLikePdf } from "./pdf.js";

/**
 * The document library: drop-folders under <workspace>/library/ whose files
 * are chunked and embedded for retrieval. Any first-level subfolder is a
 * category (library/research, library/personal, ...); files at the root get
 * the category "library".
 *
 * The files on disk are the source of truth. Everything in library_docs and
 * library_chunks is a derived cache -- unlike facts, a wipe-and-rescan is
 * always correct, which is why `enio reindex` owns these tables too. That is
 * also why this is not the facts table with a category column: facts ride the
 * every-turn memory block through a full-table scan, and a few hundred
 * documents' worth of chunks there would slow every turn and crowd identity
 * facts out of a 4000-char budget. Library text only reaches the model when
 * the librarian explicitly calls library_search.
 */

/** Same ceiling as project-index: past this a text file is tracked so the
 *  mtime diff skips it next time, but never chunked. */
const MAX_TEXT_BYTES = 512 * 1024;
/** PDFs are the format people actually file, and a 40-page paper clears
 *  512KB easily; the real cost ceiling is the extracted text, capped below. */
const MAX_PDF_BYTES = 25 * 1024 * 1024;
/** Extracted text beyond this is dropped, not summarized -- ~110 chunks is
 *  already more than retrieval will ever surface from one document. */
const MAX_DOC_CHARS = 200_000;
/** embed() truncates input at 2000 chars; chunks must fit under that or the
 *  tail of every chunk silently vanishes from its embedding. */
const CHUNK_CHARS = 1800;
/** Scan-on-search throttle, the project-index REFRESH_MS pattern: retrieval
 *  is never staler than this, and a burst of searches stats the tree once. */
const SCAN_THROTTLE_MS = 5_000;

export function libraryRoot(): string {
  return join(config.workspace, "library");
}

export interface ScanReport {
  files: number;
  indexed: number;
  removed: number;
  chunks: number;
}

export interface ScanDeps {
  embedder?: typeof embedBatch;
  onProgress?: (message: string) => void;
}

interface DocRow {
  path: string;
  category: string;
  mtime: number;
  size: number;
}

/** Files under the library root, workspace-relative, with their category.
 *  A plain walk on purpose: candidatesIn's git branch is for attached repos,
 *  and a drop-folder that happens to contain a .git should still index. */
function candidates(): Array<{ path: string; absolute: string; category: string }> {
  const root = libraryRoot();
  const out: Array<{ path: string; absolute: string; category: string }> = [];
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
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const rel = relative(root, full);
        const segments = rel.split(sep);
        out.push({
          path: join("library", rel),
          absolute: full,
          category: segments.length > 1 ? segments[0]! : "library",
        });
      }
    }
  };
  walk(root);

  // What enio writes lands at the workspace root -- meeting notes, generated
  // documents -- and "search my notes from Tuesday's meeting" should just
  // work. Root FILES only, as category "created": subfolders are other
  // machinery (attachments/, project dirs) whose contents already have homes,
  // and indexing them would put copies of every conversation attachment into
  // search results claiming to be library documents.
  try {
    for (const entry of readdirSync(config.workspace, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      out.push({
        path: entry.name,
        absolute: join(config.workspace, entry.name),
        category: "created",
      });
    }
  } catch {
    /* workspace missing: the library half is still worth scanning */
  }
  return out;
}

/** Extract indexable text, or null for what search should never claim to
 *  know: binaries, oversized files, scans with no text layer. */
async function extractText(absolute: string, size: number): Promise<string | null> {
  let head: Buffer;
  try {
    head = readFileSync(absolute).subarray(0, 8192);
  } catch {
    return null;
  }
  if (looksLikePdf(head)) {
    if (size > MAX_PDF_BYTES) return null;
    const pdf = await extractPdfText(absolute);
    return pdf?.text || null;
  }
  if (head.includes(0) || size > MAX_TEXT_BYTES) return null;
  try {
    return readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

let lastScanAt = 0;
let scanInFlight: Promise<ScanReport> | null = null;

/**
 * Bring the library index up to date with the drop-folders. Incremental on
 * (mtime, size); rows for vanished files are dropped; each file commits in
 * its own transaction so an interrupted scan loses one document, not the run.
 */
export async function scanLibrary(deps: ScanDeps = {}): Promise<ScanReport> {
  const embedder = deps.embedder ?? embedBatch;
  const db = getDb();

  const known = new Map<string, DocRow>();
  for (const row of db
    .prepare(`SELECT path, category, mtime, size FROM library_docs`)
    .all() as DocRow[]) {
    known.set(row.path, row);
  }

  const seen = new Set<string>();
  let indexed = 0;
  let chunkCount = 0;

  const upsertDoc = db.prepare(
    `INSERT OR REPLACE INTO library_docs (path, category, mtime, size, indexed_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const dropChunks = db.prepare(`DELETE FROM library_chunks WHERE doc_path = ?`);
  const insertChunk = db.prepare(
    `INSERT INTO library_chunks (doc_path, seq, text, embedding) VALUES (?, ?, ?, ?)`,
  );

  for (const file of candidates()) {
    let stat;
    try {
      stat = statSync(file.absolute);
    } catch {
      continue;
    }
    seen.add(file.path);
    const prior = known.get(file.path);
    if (prior && prior.mtime === stat.mtimeMs && prior.size === stat.size) continue;

    const text = await extractText(file.absolute, stat.size);
    const chunks = text ? chunkTranscript(text.slice(0, MAX_DOC_CHARS), CHUNK_CHARS) : [];
    // Embed outside the transaction: better-sqlite3 transactions are
    // synchronous, and the model call is the slow part anyway.
    const vectors = chunks.length ? await embedder(chunks) : [];

    db.transaction(() => {
      upsertDoc.run(file.path, file.category, stat.mtimeMs, stat.size, Date.now());
      dropChunks.run(file.path);
      chunks.forEach((chunk, i) => {
        const vec = vectors[i];
        insertChunk.run(file.path, i, chunk, vec ? toBlob(vec) : null);
      });
    })();

    if (chunks.length) {
      indexed++;
      chunkCount += chunks.length;
      deps.onProgress?.(`indexed ${file.path} (${chunks.length} chunk(s))`);
    }
  }

  let removed = 0;
  const dropDoc = db.prepare(`DELETE FROM library_docs WHERE path = ?`);
  for (const path of known.keys()) {
    if (!seen.has(path)) {
      db.transaction(() => {
        dropChunks.run(path); // CASCADE would too, but the FTS delete trigger must fire per row
        dropDoc.run(path);
      })();
      removed++;
    }
  }

  await backfillChunkEmbeddings(embedder);

  lastScanAt = Date.now();
  return { files: seen.size, indexed, removed, chunks: chunkCount };
}

/** Chunks written while embeddings were degraded carry NULL vectors and are
 *  lexical-only. Each scan retries them, the backfillEntityEmbeddings
 *  pattern: one failing batch means still degraded, stop quietly. */
async function backfillChunkEmbeddings(embedder: typeof embedBatch): Promise<void> {
  const db = getDb();
  const update = db.prepare(`UPDATE library_chunks SET embedding = ? WHERE id = ?`);
  for (;;) {
    const rows = db
      .prepare(`SELECT id, text FROM library_chunks WHERE embedding IS NULL LIMIT 256`)
      .all() as Array<{ id: number; text: string }>;
    if (rows.length === 0) return;
    const vectors = await embedder(rows.map((r) => r.text));
    if (vectors.every((v) => v === null)) return;
    db.transaction(() => {
      rows.forEach((row, i) => {
        const vec = vectors[i];
        if (vec) update.run(toBlob(vec), row.id);
      });
    })();
    if (rows.length < 256) return;
  }
}

/** Scan at most once per throttle window; concurrent callers share one scan. */
export async function ensureFresh(deps: ScanDeps = {}): Promise<void> {
  if (Date.now() - lastScanAt < SCAN_THROTTLE_MS) return;
  if (!scanInFlight) {
    scanInFlight = scanLibrary(deps).finally(() => {
      scanInFlight = null;
    });
  }
  try {
    await scanInFlight;
  } catch {
    // The index is a cache; search still works on whatever is already there.
  }
}

export interface LibraryHit {
  path: string;
  category: string;
  seq: number;
  text: string;
  score: number;
}

/**
 * Semantic search over chunks, with FTS/keyword hits appended below -- exact
 * terms (a filename, an invoice number) that embeddings miss. The two scores
 * are different scales and are never compared against each other: semantic
 * hits rank first, lexical hits fill the remainder. Same lesson as the
 * facts thresholds.
 */
export async function searchLibrary(
  query: string,
  opts: { category?: string; limit?: number; embedder?: typeof embed } = {},
): Promise<LibraryHit[]> {
  const limit = opts.limit ?? 8;
  await ensureFresh();
  const db = getDb();

  const qvec = await (opts.embedder ?? embed)(query);
  const where = opts.category ? `WHERE d.category = ?` : "";
  const params = opts.category ? [opts.category] : [];
  const rows = db
    .prepare(
      `SELECT c.id, c.doc_path, c.seq, c.text, c.embedding, d.category
       FROM library_chunks c JOIN library_docs d ON d.path = c.doc_path ${where}`,
    )
    .all(...params) as Array<{
    id: number;
    doc_path: string;
    seq: number;
    text: string;
    embedding: Buffer | null;
    category: string;
  }>;

  // Cosine ~0.25 is a permissive floor for related text; keyword overlap of
  // 0.15 is one meaningful term matched. Per-mode, never shared.
  const threshold = qvec ? 0.25 : 0.15;
  const scored: LibraryHit[] = [];
  for (const row of rows) {
    const vec = fromBlob(row.embedding);
    const score = qvec && vec ? cosine(qvec, vec) : keywordScore(query, row.text);
    if (score >= threshold) {
      scored.push({ path: row.doc_path, category: row.category, seq: row.seq, text: row.text, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const hits = scored.slice(0, limit);
  // The lexical channel is a rescue, not a filler: it exists for the exact
  // term embeddings miss (an invoice number, a filename). Topping up healthy
  // semantic results with OR-matched FTS hits buried one real source under
  // seven weak ones -- every "my" and "on" in the query matches something.
  if (hits.length === 0 && libraryFtsAvailable) {
    const have = new Set(hits.map((h) => `${h.path}:${h.seq}`));
    try {
      const ftsRows = db
        .prepare(
          `SELECT c.doc_path, c.seq, c.text, d.category, bm25(library_fts) AS rank
           FROM library_fts JOIN library_chunks c ON c.id = library_fts.rowid
           JOIN library_docs d ON d.path = c.doc_path
           WHERE library_fts MATCH ? ${opts.category ? "AND d.category = ?" : ""}
           ORDER BY rank LIMIT ?`,
        )
        .all(toFtsQuery(query), ...params, limit) as Array<{
        doc_path: string;
        seq: number;
        text: string;
        category: string;
        rank: number;
      }>;
      for (const row of ftsRows) {
        if (hits.length >= limit) break;
        if (have.has(`${row.doc_path}:${row.seq}`)) continue;
        hits.push({
          path: row.doc_path,
          category: row.category,
          seq: row.seq,
          text: row.text,
          score: 1 / (1 + Math.abs(row.rank)),
        });
      }
    } catch {
      /* malformed FTS query -- the scored results above still stand */
    }
  }
  return hits;
}

export interface CategoryInfo {
  name: string;
  files: number;
  chunks: number;
}

/** Categories from disk and DB merged: a freshly created empty folder is a
 *  real category the tool should accept, even before anything is indexed. */
export function libraryCategories(): CategoryInfo[] {
  const db = getDb();
  const byName = new Map<string, CategoryInfo>();
  const rows = db
    .prepare(
      `SELECT d.category AS name, COUNT(DISTINCT d.path) AS files, COUNT(c.id) AS chunks
       FROM library_docs d LEFT JOIN library_chunks c ON c.doc_path = d.path
       GROUP BY d.category`,
    )
    .all() as CategoryInfo[];
  for (const row of rows) byName.set(row.name, row);
  try {
    for (const entry of readdirSync(libraryRoot(), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !byName.has(entry.name)) {
        byName.set(entry.name, { name: entry.name, files: 0, chunks: 0 });
      }
    }
  } catch {
    /* root missing: DB view is the whole truth */
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface LibraryStatus {
  root: string;
  docs: number;
  chunks: number;
  pendingEmbeddings: number;
  categories: CategoryInfo[];
  lastScanAt: number | null;
}

export function libraryStatus(): LibraryStatus {
  const db = getDb();
  const docs = (db.prepare(`SELECT COUNT(*) AS n FROM library_docs`).get() as { n: number }).n;
  const chunks = (db.prepare(`SELECT COUNT(*) AS n FROM library_chunks`).get() as { n: number }).n;
  const pending = (
    db.prepare(`SELECT COUNT(*) AS n FROM library_chunks WHERE embedding IS NULL`).get() as {
      n: number;
    }
  ).n;
  return {
    root: libraryRoot(),
    docs,
    chunks,
    pendingEmbeddings: pending,
    categories: libraryCategories(),
    lastScanAt: lastScanAt || null,
  };
}

/** Wipe the derived cache. Trivially correct -- the files are still there. */
export function resetLibrary(): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM library_chunks`).run();
    db.prepare(`DELETE FROM library_docs`).run();
  })();
  lastScanAt = 0;
}
