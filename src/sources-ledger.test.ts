import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-sources-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");

const { sourceLedger, sourceKey } = await import("./memory/sources-ledger.js");
const { rememberFact } = await import("./memory/store.js");
const { addExemplar } = await import("./memory/learning.js");
const { recordTurn } = await import("./memory/traces.js");
const { closeDb, getDb } = await import("./memory/db.js");

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

describe("the source ledger", () => {
  test("a place is one row: hosts by name, files and handoffs by prefix", () => {
    assert.equal(sourceKey("https://www.example.org/a/b?x=1"), "example.org");
    assert.equal(sourceKey("https://docs.example.org/page"), "docs.example.org");
    assert.equal(sourceKey("handoff:claude"), "handoff:claude");
    assert.equal(sourceKey("notes/lease.md"), "file:notes/lease.md");
    assert.equal(sourceKey(""), null);
  });

  test("facts count per origin, with what was superseded and what was pinned", async () => {
    await rememberFact("The deposit is 1200", { origin: "https://www.example.org/lease" });
    await rememberFact("The lease ends in May", { origin: "https://example.org/lease-2", pinned: true });
    await rememberFact("The deposit is 1500", { origin: "https://example.org/lease-3", corrects: true });
    await rememberFact("Rust 1.80 is out", { origin: "handoff:claude" });
    const byKey = Object.fromEntries(sourceLedger().map((r) => [r.source, r]));
    assert.equal(byKey["example.org"]!.facts, 3);
    assert.equal(byKey["example.org"]!.superseded, 1, "the corrected deposit fact");
    assert.equal(byKey["example.org"]!.live, 2);
    assert.equal(byKey["example.org"]!.pinned, 1);
    assert.equal(byKey["handoff:claude"]!.facts, 1);
  });

  test("a good answer credits the pages its turn read — stored by turn id at save time, not joined on text later", async () => {
    const turnId = recordTurn({
      sessionId: "s1",
      question: "what is the capital of portugal",
      reply: "Lisbon.",
      specialist: "researcher",
      systemPrompt: "",
      memoryBlock: "",
      startedAt: Date.now(),
      durationMs: 10,
      iterations: 1,
      steps: [
        { seq: 0, kind: "tool", name: "web_search", args: JSON.stringify({ query: "capital of portugal" }), output: "1. Portugal\n   https://en.wikipedia.org/wiki/Portugal\n   A country." },
        { seq: 1, kind: "tool", name: "web_fetch", args: JSON.stringify({ url: "https://en.wikipedia.org/wiki/Portugal" }), output: "Lisbon is the capital of Portugal. ".repeat(20) },
      ],
    });
    const r = await addExemplar("what is the capital of portugal", "Lisbon.");
    assert.ok(r.added);
    const stored = getDb().prepare(`SELECT turn_id FROM exemplars WHERE question = ?`).get("what is the capital of portugal") as { turn_id: number };
    assert.equal(stored.turn_id, turnId, "resolved to the exchange that was marked good");
    const wiki = sourceLedger().find((x) => x.source === "en.wikipedia.org");
    assert.ok(wiki);
    assert.equal(wiki!.good, 1, "credited once, the fetch not the listing");
    assert.equal(wiki!.facts, 0);
  });
});
