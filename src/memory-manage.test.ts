import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The management surface behind the desktop's Memory dialog: listing what
 * memory holds, pinning, forgetting a fact, and forgetting one summary
 * without touching its transcript.
 */
const scratch = mkdtempSync(join(tmpdir(), "enio-memory-manage-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
// The bundled skills live in the checkout now, so a suite that redirects
// only the data dir would still load them into every prompt it measures.
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-such-mcp.json");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });

const { getDb, closeDb } = await import("./memory/db.js");
const store = await import("./memory/store.js");

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

describe("memory management", () => {
  test("facts list, pin, and forget round-trip", async () => {
    await store.rememberFact("the user drinks tea, not coffee", { source: "cli" });
    const listed = store.listFacts();
    const fact = listed.find((f) => f.text.includes("tea"));
    assert.ok(fact, "stored fact is listed");
    assert.equal(fact!.pinned, false);
    assert.equal(fact!.source, "cli");

    assert.ok(store.setFactPinned(fact!.id, true));
    assert.equal(store.listFacts().find((f) => f.id === fact!.id)!.pinned, true);
    // Pinned rows sort first — that is the order the dialog shows.
    assert.equal(store.listFacts()[0]!.id, fact!.id);

    assert.ok(store.forgetFact(String(fact!.id)));
    assert.ok(!store.listFacts().some((f) => f.id === fact!.id));
  });

  test("forgetting a summary keeps the transcript and resists background re-indexing", () => {
    const sessionId = store.startSession();
    store.logMessage(sessionId, "user", "we discussed the quarterly numbers at length");
    getDb()
      .prepare(`UPDATE sessions SET summary = 'Quarterly numbers discussion.', indexed = 1 WHERE id = ?`)
      .run(sessionId);

    assert.ok(store.listSummaries().some((s) => s.sessionId === sessionId));
    assert.ok(store.forgetSummary(sessionId));
    assert.ok(!store.listSummaries().some((s) => s.sessionId === sessionId));

    // The transcript survives — forgetting the summary is not forgetting
    // the conversation; that is the History dialog's job.
    const messages = store.conversationMessages(sessionId);
    assert.ok(messages.some((m) => m.content.includes("quarterly numbers")));

    // indexed stayed 1, so the next background pass will not regenerate
    // what was just forgotten. (enio reindex will — deliberately.)
    const row = getDb()
      .prepare(`SELECT indexed, summary FROM sessions WHERE id = ?`)
      .get(sessionId) as { indexed: number; summary: string | null };
    assert.equal(row.indexed, 1);
    assert.equal(row.summary, null);

    // Forgetting twice reports honestly.
    assert.equal(store.forgetSummary(sessionId), false);
  });
});

describe("referencesPast", () => {
  test("past-referring phrasings open the summary channel; present ones do not", () => {
    for (const q of [
      "what was I doing yesterday?",
      "remind me what we discussed",
      "where did we leave off",
      "you mentioned a deploy step earlier",
      "recap last week",
    ]) {
      assert.equal(store.referencesPast(q), true, q);
    }
    for (const q of [
      "write me a resume",
      "find the security deposit in my lease notes",
      "package this task for a bigger model",
      "what is the weather like",
    ]) {
      assert.equal(store.referencesPast(q), false, q);
    }
  });
});

describe("extraction shapes that cannot be true", () => {
  test("a thing cannot prefer, avoid, know or learn — those triples are dropped", async () => {
    const { dedupe } = await import("./memory/extract.js");
    // Verbatim from the graph: an MCP echo test ("say the sky is green")
    // became these two rows, sat for five days, and surfaced on "what news
    // today?" — where the model wove them into an invented weather report.
    // The prompt now says whose facts these are; this is the check that
    // does not depend on the model having read it.
    const out = dedupe([
      { subject: "sky", subject_type: "concept", relation: "PREFERS", object: "being blue", object_type: "concept" },
      { subject: "sky", subject_type: "concept", relation: "AVOIDS", object: "being green", object_type: "concept" },
      // These are the shapes that SHOULD survive — including a project or a
      // technology USING something, which the first cut of this filter
      // wrongly dropped: the real graph holds six such edges.
      { subject: "Hyper", subject_type: "technology", relation: "USES", object: "Electron", object_type: "technology" },
      { subject: "user", subject_type: "person", relation: "PREFERS", object: "teal", object_type: "concept" },
      { subject: "Ana", subject_type: "person", relation: "KNOWS", object: "Rust", object_type: "technology" },
      { subject: "deploy tool", subject_type: "project", relation: "PART_OF", object: "Acme", object_type: "organization" },
      { subject: "Acme", subject_type: "organization", relation: "LOCATED_IN", object: "Lisbon", object_type: "place" },
    ]);
    const kept = out.map((t) => `${t.subject} ${t.relation} ${t.object}`);
    assert.deepEqual(kept, [
      "Hyper USES Electron",
      "user PREFERS teal",
      "Ana KNOWS Rust",
      "deploy tool PART_OF Acme",
      "Acme LOCATED_IN Lisbon",
    ]);
  });
});
