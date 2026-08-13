import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Temporal memory: the recency channel in the memory block, and the fold
 * summary that lets a long session's durable summary cover its whole arc.
 * Both fix quiet losses — "what was I doing yesterday" matching nothing, and
 * a summary that silently omitted everything after the first 12k characters.
 */
const scratch = mkdtempSync(join(tmpdir(), "enio-memory-notes-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
// A configured MCP server would otherwise be SPAWNED by buildRegistry:
// the developer's own ~/.enio/mcp.json is real, and a suite that starts
// npx servers hangs for minutes and depends on the machine.
process.env.ENIO_MCP_CONFIG = join(scratch, "no-such-mcp.json");
// Machine-wide state (model choice, desktop-control consent) must never be
// read from or written to the developer's real machine by a test.
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
// A window this small makes compaction reachable with a handful of scripted
// turns instead of forty.
process.env.ENIO_HISTORY_WINDOW = "3";
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });

const { getDb } = await import("./memory/db.js");
const {
  startSession,
  logMessage,
  saveFoldSummary,
  summaryInput,
  recentSummaries,
  buildMemoryBlock,
  indexPending,
} = await import("./memory/store.js");

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  rmSync(scratch, { recursive: true, force: true });
});

function sse(content: string): Response {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("the embedding cache is isolated from the real one", () => {
  test("it lives under the (redirected) data dir", async () => {
    // Tests stub globalThis.fetch with scripted chat responses -- exactly the
    // frames built above. transformers.js once cached those frames as model
    // files in its node_modules default cache, which the REAL agent then
    // read: every startup failed with a JSON parse error on an SSE chunk,
    // and recall silently degraded to keyword-only. The cache living under
    // config.dataDir is the fix, because tests redirect that to a scratch
    // dir -- so a test can no longer write where the agent reads.
    const { embeddingCacheDir } = await import("./memory/embed.js");
    const { config } = await import("./config.js");
    assert.ok(embeddingCacheDir().startsWith(config.dataDir));
    assert.ok(config.dataDir.includes("enio-memory-notes-"), "this suite runs on a scratch dir");
  });
});

describe("summaryInput", () => {
  test("a transcript that fits goes in whole", () => {
    assert.equal(summaryInput("short conversation", null), "short conversation");
    assert.equal(summaryInput("short conversation", "some fold"), "short conversation");
  });

  test("a long transcript without a fold falls back to the head slice", () => {
    const long = "a".repeat(20000);
    const input = summaryInput(long, null);
    assert.equal(input.length, 12000);
    assert.equal(input[0], "a");
  });

  test("a long transcript with a fold covers both ends", () => {
    // The head-only slice was the quiet loss: whatever a long session ended
    // on was exactly what its summary omitted.
    const transcript = "EARLY ".repeat(2000) + "THE FINAL DECISION WAS X";
    const input = summaryInput(transcript, "fold: the early part discussed Y");
    assert.match(input, /fold: the early part discussed Y/);
    assert.match(input, /THE FINAL DECISION WAS X/);
  });
});

describe("recentSummaries", () => {
  test("returns the last two days, newest first, summarised sessions only", () => {
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO sessions (id, started_at, summary, indexed) VALUES (?, ?, ?, 1)`,
    );
    const now = Date.now();
    insert.run("s-now", now, "worked on the parser today");
    insert.run("s-yesterday", now - 40 * 3600_000, "set up the deploy pipeline");
    insert.run("s-old", now - 5 * 24 * 3600_000, "ancient history");
    db.prepare(`INSERT INTO sessions (id, started_at, indexed) VALUES (?, ?, 0)`).run(
      "s-unsummarised",
      now,
    );

    const recent = recentSummaries();
    assert.deepEqual(
      recent.map((r) => r.summary),
      ["worked on the parser today", "set up the deploy pipeline"],
    );
  });

  test("a question about the past gets them, with day labels", async () => {
    // Nothing about this query RESEMBLES either summary — recency is its own
    // channel, not a lucky similarity hit. But the question must actually be
    // about the past: "yesterday" is the marker that opens the channel.
    const block = await buildMemoryBlock("what was I doing yesterday?");
    assert.match(block, /Recent sessions:/);
    assert.match(block, /\(today\) worked on the parser today/);
    assert.match(block, /\(yesterday\) set up the deploy pipeline/);
    assert.doesNotMatch(block, /ancient history/);
  });

  test("a question about the present gets no summaries at all", async () => {
    // The scar this guards: summaries rode into every turn, and a live
    // handoff packaged last week's summarised project as the current task.
    // A summary records what happened once; only facts and the graph are
    // ambient context.
    const block = await buildMemoryBlock("completely unrelated question about cheese");
    assert.doesNotMatch(block, /Recent sessions:/);
    assert.doesNotMatch(block, /Earlier conversations:/);
  });
});

describe("the fold summary reaches the durable session summary", () => {
  test("indexPending feeds fold + tail to the summariser for long sessions", async () => {
    const sessionId = startSession();
    // A transcript well past the 12k head slice, whose *end* holds the fact
    // that must survive into the summary.
    for (let i = 0; i < 30; i++) {
      logMessage(sessionId, "user", `filler exchange number ${i} ` + "pad ".repeat(150));
    }
    logMessage(sessionId, "assistant", "CONCLUSION: the flight is at 9:40");
    saveFoldSummary(sessionId, "FOLD: early discussion of travel plans");

    let summariserSaw = "";
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = String(init?.body ?? "");
      if (body.includes("2-4 sentences of plain prose")) {
        summariserSaw = body;
        return sse("A trip was planned; the flight is at 9:40.");
      }
      return sse("[]"); // extraction and everything else: nothing to extract
    }) as typeof fetch;

    await indexPending();

    assert.match(summariserSaw, /FOLD: early discussion of travel plans/);
    assert.match(summariserSaw, /CONCLUSION: the flight is at 9:40/);
    const row = getDb()
      .prepare(`SELECT summary FROM sessions WHERE id = ?`)
      .get(sessionId) as { summary: string };
    assert.match(row.summary, /9:40/);
  });
});

describe("compaction persists its fold", () => {
  test("a folded turn leaves its summary on the session row", async () => {
    const { runTurn } = await import("./agent.js");
    const { buildRegistry } = await import("./tools/index.js");
    const registry = await buildRegistry();
    const sessionId = startSession();

    globalThis.fetch = (async (_url: any, init: any) => {
      const body = String(init?.body ?? "");
      if (body.includes("Summarise this earlier part")) {
        return sse("FOLD NOTES: the user asked about a, b and c.");
      }
      return sse("a reply");
    }) as typeof fetch;

    // Four turns against a window of three: the fourth folds the first.
    const history: any[] = [];
    for (const q of ["about a", "about b", "about c", "about d"]) {
      await runTurn(`tell me ${q}`, history, registry, sessionId, {}, { specialist: "coder" });
    }

    const row = getDb()
      .prepare(`SELECT fold_summary AS f FROM sessions WHERE id = ?`)
      .get(sessionId) as { f: string | null };
    assert.match(String(row.f), /FOLD NOTES/);
  });
});
