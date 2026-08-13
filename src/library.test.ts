import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "enio-library-"));
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-such-mcp.json");

const library = await import("./library.js");
const { libraryTools } = await import("./tools/library.js");
const { getDb, closeDb } = await import("./memory/db.js");
const { ensureDirs } = await import("./config.js");

ensureDirs();
const ROOT = library.libraryRoot();

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

/** Deterministic embeddings: one unit axis per topic word. Orthogonal topics
 *  score cosine 0, matching topics 1 — thresholds become exact. */
const AXES = ["quantum", "cooking", "sailing"];
function vecFor(text: string): Float32Array {
  const v = new Float32Array(AXES.length + 1);
  const t = text.toLowerCase();
  AXES.forEach((word, i) => {
    if (t.includes(word)) v[i] = 1;
  });
  if (![...v].some(Boolean)) v[AXES.length] = 1;
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm) as Float32Array;
}
const fakeBatch = async (texts: string[]) => texts.map(vecFor);
const fakeEmbed = async (text: string) => vecFor(text);
/** Degraded embedder: what embedBatch returns with no model and no network. */
const nullBatch = async (texts: string[]) => texts.map(() => null);

/** A minimal but well-formed one-page PDF whose text layer says `text`.
 *  Assembled with real byte offsets so pdf.js parses it without repair. */
function minimalPdf(text: string): Buffer {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    null as string | null,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  ];
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) body += `${String(at).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const chunkCount = (path: string) =>
  (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM library_chunks WHERE doc_path = ?`)
      .get(path) as { n: number }
  ).n;

test("a scan indexes drop-folders into categories, including PDFs", async () => {
  mkdirSync(join(ROOT, "research"), { recursive: true });
  mkdirSync(join(ROOT, "personal"), { recursive: true });
  writeFileSync(join(ROOT, "research", "quantum.md"), "Notes on quantum entanglement basics.");
  writeFileSync(join(ROOT, "research", "paper.pdf"), minimalPdf("quantum error correction survey"));
  writeFileSync(join(ROOT, "personal", "recipes.txt"), "Slow cooking a Sunday ragu properly.");
  writeFileSync(join(ROOT, "loose-note.txt"), "A sailing checklist for the weekend.");

  const report = await library.scanLibrary({ embedder: fakeBatch });
  assert.equal(report.files, 4);
  assert.equal(report.indexed, 4);
  assert.ok(report.chunks >= 4);

  const cats = library.libraryCategories();
  const names = cats.map((c) => c.name);
  assert.deepEqual(names, ["library", "personal", "research"]);
  assert.equal(cats.find((c) => c.name === "research")!.files, 2);
  assert.equal(cats.find((c) => c.name === "library")!.files, 1, "root files land in 'library'");
});

test("an unchanged rescan is a no-op", async () => {
  const report = await library.scanLibrary({ embedder: fakeBatch });
  assert.equal(report.indexed, 0);
  assert.equal(report.chunks, 0);
  assert.equal(report.removed, 0);
});

test("semantic search ranks the matching topic first and drops orthogonal ones", async () => {
  const hits = await library.searchLibrary("tell me about quantum research", {
    embedder: fakeEmbed,
  });
  assert.ok(hits.length >= 1);
  assert.match(hits[0]!.text, /quantum/i);
  assert.equal(hits[0]!.category, "research");
  assert.ok(
    hits.every((h) => !/ragu/.test(h.text)),
    "cooking never matches a quantum query on either channel",
  );
});

test("the PDF's text layer is retrievable with the file as provenance", async () => {
  const hits = await library.searchLibrary("quantum error correction", { embedder: fakeEmbed });
  assert.ok(
    hits.some((h) => h.path === join("library", "research", "paper.pdf")),
    `pdf hit missing from: ${hits.map((h) => h.path).join(", ")}`,
  );
});

test("a category filter excludes the other folders", async () => {
  const hits = await library.searchLibrary("quantum sailing cooking", {
    category: "personal",
    embedder: fakeEmbed,
  });
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((h) => h.category === "personal"));
});

test("with embeddings degraded, exact terms still hit through the lexical channel", async () => {
  const nullEmbed = async () => null;
  const hits = await library.searchLibrary("ragu", { embedder: nullEmbed });
  assert.ok(hits.length >= 1);
  assert.match(hits[0]!.text, /ragu/);
});

test("an edited file re-chunks and its stale chunks are gone", async () => {
  const file = join(ROOT, "research", "quantum.md");
  writeFileSync(file, "Revised notes: quantum teleportation protocols.");
  // mtimeMs resolution can swallow a same-millisecond rewrite; force it.
  const future = (Date.now() + 5_000) / 1000;
  utimesSync(file, future, future);

  const report = await library.scanLibrary({ embedder: fakeBatch });
  assert.equal(report.indexed, 1);
  const rows = getDb()
    .prepare(`SELECT text FROM library_chunks WHERE doc_path = ?`)
    .all(join("library", "research", "quantum.md")) as Array<{ text: string }>;
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.text, /teleportation/);
  assert.ok(!rows[0]!.text.includes("entanglement"), "old chunk text replaced");
});

test("a deleted file takes its chunks with it", async () => {
  const stored = join("library", "personal", "recipes.txt");
  assert.ok(chunkCount(stored) > 0);
  unlinkSync(join(ROOT, "personal", "recipes.txt"));
  const report = await library.scanLibrary({ embedder: fakeBatch });
  assert.equal(report.removed, 1);
  assert.equal(chunkCount(stored), 0);
});

test("binaries and oversized text are tracked but never chunked", async () => {
  mkdirSync(join(ROOT, "admin"), { recursive: true });
  writeFileSync(join(ROOT, "admin", "photo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d]));
  writeFileSync(join(ROOT, "admin", "huge.txt"), "x".repeat(600 * 1024));
  const report = await library.scanLibrary({ embedder: fakeBatch });
  assert.equal(report.chunks, 0, "neither file produced chunks");
  assert.equal(chunkCount(join("library", "admin", "photo.bin")), 0);
  assert.equal(chunkCount(join("library", "admin", "huge.txt")), 0);
  // Tracked: the next scan's mtime diff skips them instead of re-reading.
  const rescan = await library.scanLibrary({ embedder: fakeBatch });
  assert.equal(rescan.indexed, 0);
});

test("extracted text is capped per document, not summarized", async () => {
  // 300k chars of 99-char lines: the 200k cap holds chunk count near 112.
  const line = "sailing conditions were recorded for the harbour and the forecast looked stable overall today.\n";
  writeFileSync(join(ROOT, "admin", "log.txt"), line.repeat(3200));
  await library.scanLibrary({ embedder: fakeBatch });
  const n = chunkCount(join("library", "admin", "log.txt"));
  assert.ok(n > 90 && n <= 120, `expected ~112 capped chunks, got ${n}`);
});

test("chunks written while degraded are backfilled when embeddings recover", async () => {
  mkdirSync(join(ROOT, "inbox"), { recursive: true });
  writeFileSync(join(ROOT, "inbox", "memo.txt"), "quantum budget memo for the quarter.");
  await library.scanLibrary({ embedder: nullBatch });
  const path = join("library", "inbox", "memo.txt");
  const nullRows = () =>
    (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM library_chunks WHERE doc_path = ? AND embedding IS NULL`)
        .get(path) as { n: number }
    ).n;
  assert.ok(nullRows() > 0, "degraded scan stored NULL embeddings");
  await library.scanLibrary({ embedder: fakeBatch });
  assert.equal(nullRows(), 0, "recovered scan backfilled the vectors");
  const hits = await library.searchLibrary("quantum memo", { embedder: fakeEmbed });
  assert.ok(hits.some((h) => h.path === path));
});

test("the library_search tool answers with provenance; an invented category degrades to everywhere", async () => {
  const tool = libraryTools.find((t) => t.name === "library_search")!;
  const out = String(await tool.run({ query: "quantum teleportation" }));
  assert.match(out, /\[research\]/);
  assert.match(out, /library\/research\/quantum\.md/);
  assert.match(out, /teleportation/);

  // A live trace showed the model inventing category names twice and giving
  // up on two refusals -- so an unknown category searches everything and says
  // so, instead of handing the model a dead end to retry.
  const degraded = String(await tool.run({ query: "quantum teleportation", category: "taxes" }));
  assert.match(degraded, /No category named "taxes"/);
  assert.match(degraded, /research/, "the correction names the real folders");
  assert.match(degraded, /teleportation/, "the search still ran, unscoped");

  const empty = String(await tool.run({ query: "zzz nonexistent topic qqq" }));
  assert.match(empty, /Nothing in the library matches/);
});

test("resetLibrary wipes the cache and the next search rebuilds it from disk", async () => {
  library.resetLibrary();
  assert.equal(library.libraryStatus().docs, 0);
  assert.equal(library.libraryStatus().chunks, 0);
  // reset zeroes the scan throttle, so search itself triggers the rescan --
  // the files on disk are the source of truth, nothing was lost.
  const hits = await library.searchLibrary("quantum teleportation", { embedder: fakeEmbed });
  assert.ok(hits.length >= 1);
  assert.ok(library.libraryStatus().docs > 0);
});

test("an empty category folder is a real category before anything is indexed", async () => {
  mkdirSync(join(ROOT, "receipts"), { recursive: true });
  const names = library.libraryCategories().map((c) => c.name);
  assert.ok(names.includes("receipts"));
});
