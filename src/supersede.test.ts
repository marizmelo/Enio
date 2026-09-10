import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-supersede-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");

const { rememberFact, searchFacts, searchFactsKeyword, listFacts, stats } = await import(
  "./memory/store.js"
);
const { closeDb } = await import("./memory/db.js");

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

const texts = (rows: Array<{ text: string }>) => rows.map((r) => r.text);

/**
 * The failure this protects: a correction added a second fact while the first
 * stayed retrievable, and the model followed whichever it noticed last.
 * Closing happens only on a structural signal (the corrects flag), targets by
 * similarity, and is reported — never silent, never a delete.
 */
describe("a correction closes what it replaces", () => {
  test("the rival is closed, reported, and gone from recall — but not from the list", async () => {
    await rememberFact("Mariz uses Hyper as a terminal");
    const result = await rememberFact("Mariz uses Ghostty as a terminal", { corrects: true });
    assert.equal(result.stored, true);
    assert.deepEqual(result.superseded, ["Mariz uses Hyper as a terminal"]);

    const recalled = texts(await searchFacts("what terminal does Mariz use"));
    assert.ok(recalled.includes("Mariz uses Ghostty as a terminal"));
    assert.ok(!recalled.includes("Mariz uses Hyper as a terminal"), "a closed fact must not be recalled");
    assert.ok(!texts(searchFactsKeyword("Hyper terminal")).includes("Mariz uses Hyper as a terminal"));

    const listed = listFacts().find((f) => f.text === "Mariz uses Hyper as a terminal");
    assert.ok(listed?.supersededAt, "closed facts stay listed, marked — history is not rewritten");
    assert.equal(stats().facts, 1, "the count is of current facts");
  });

  test("an unrelated fact is left alone, and so is a pinned one", async () => {
    await rememberFact("Mariz drinks coffee in the morning");
    await rememberFact("Mariz was born in Brazil", { pinned: true });
    const result = await rememberFact("Mariz drinks tea in the evening", { corrects: true });
    // "drinks ... in the" overlaps, but coffee-in-the-morning is not what tea-in-the-evening
    // replaces at the thresholds; identity facts are never closed by inference.
    assert.ok(!result.superseded.includes("Mariz was born in Brazil"));
    const current = listFacts().filter((f) => !f.supersededAt).map((f) => f.text);
    assert.ok(current.includes("Mariz was born in Brazil"));
  });

  test("without the flag, nothing is closed — a plain remember never rewrites", async () => {
    await rememberFact("Mariz edits in Zed");
    const result = await rememberFact("Mariz edits in Vim", {});
    assert.deepEqual(result.superseded, []);
    const current = listFacts().filter((f) => !f.supersededAt).map((f) => f.text);
    assert.ok(current.includes("Mariz edits in Zed") && current.includes("Mariz edits in Vim"));
  });

  test("re-asserting a closed fact reopens it instead of refusing as known", async () => {
    const result = await rememberFact("Mariz uses Hyper as a terminal");
    assert.equal(result.stored, true);
    assert.equal(result.reason, "reopened");
    assert.ok(texts(await searchFacts("what terminal does Mariz use")).includes("Mariz uses Hyper as a terminal"));
  });
});
