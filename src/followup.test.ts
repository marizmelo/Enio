import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

// Config reads these at module load, and the model URL points at a port
// nothing listens on: the last test wants a model that cannot answer.
const dir = mkdtempSync(join(tmpdir(), "enio-followup-"));
process.env.ENIO_DATA_DIR = join(dir, "data");
process.env.ENIO_WORKSPACE = join(dir, "ws");
process.env.ENIO_MACHINE_STATE_DIR = join(dir, "machine");
process.env.ENIO_MCP_CONFIG = join(dir, "none.json");
process.env.ENIO_BUILTIN_SKILLS = join(dir, "skills");
process.env.ENIO_BASE_URL = "http://127.0.0.1:9/v1";

const { acceptRewrite, seedQuery, threadBefore } = await import("./followup.js");

const CUP_THREAD =
  "weren't there games for the Brazilian Cup yesterday?\n" +
  "No games took place for the Brazilian Cup on 25 November 2026. The final is between Palmeiras and Grêmio.";

describe("a follow-up's search query is completed from the thread", () => {
  test("words the thread holds may be added to the question", () => {
    assert.deepEqual(
      acceptRewrite("What happened to Flamengo?", "what happened to Flamengo Brazilian Cup 2026", CUP_THREAD),
      ["brazilian", "2026"],
    );
  });

  test("a word the conversation never held refuses the whole rewrite", () => {
    // The model reaching for what it remembers is the failure the seeded
    // search exists to prevent; a query is the last place to let it back in.
    assert.equal(
      acceptRewrite("What happened to Flamengo?", "what happened to Flamengo Libertadores final", CUP_THREAD),
      null,
    );
  });

  test("the subject the user typed may not be swapped for the thread's", () => {
    assert.equal(
      acceptRewrite("who won the formula race in interlagos", "who won the Brazilian Cup", CUP_THREAD),
      null,
    );
  });

  test("a word that stands for something earlier may be replaced by it", () => {
    const thread = "tell me about the new iphone\nThe iPhone 18 Pro was announced in September.";
    assert.deepEqual(acceptRewrite("how much does that cost", "how much does the iPhone 18 Pro cost", thread), ["iphone"]);
    assert.deepEqual(acceptRewrite("what do they think of it", "what do reviewers think of the iPhone", thread), null, "reviewers is not in the thread");
  });

  test("a rewrite that adds nothing, or is not one line of query, is not a rewrite", () => {
    assert.equal(acceptRewrite("What happened to Flamengo?", "what happened to flamengo", CUP_THREAD), null);
    assert.equal(acceptRewrite("What happened to Flamengo?", "Flamengo Brazilian\nCup", CUP_THREAD), null);
    assert.equal(acceptRewrite("What happened to Flamengo?", "Flamengo " + "cup ".repeat(80), CUP_THREAD), null);
  });
});

describe("what counts as the thread", () => {
  test("the question being asked is not its own context, and harness notes are not the user's", () => {
    const thread = threadBefore([
      { role: "system", content: "You are the researcher." },
      { role: "user", content: "were there cup games yesterday?" },
      { role: "assistant", content: "No, none were played." },
      { role: "user", content: "(Only two tool calls remain for this turn.)" },
      { role: "user", content: "what happened to Flamengo?" },
    ]);
    assert.deepEqual(thread.questions, ["were there cup games yesterday?"]);
    assert.equal(thread.reply, "No, none were played.");
    assert.ok(!thread.text.includes("Flamengo"));
  });
});

describe("the seeded query never fails a turn", () => {
  test("a first question is searched as typed, without asking the model", async () => {
    const out = await seedQuery("  who won the cup?  ", [
      { role: "system", content: "x" },
      { role: "user", content: "who won the cup?" },
    ]);
    assert.deepEqual(out, { query: "who won the cup?", via: "words", added: [] });
  });

  test("a model that cannot be reached leaves the user's own words", async () => {
    const out = await seedQuery("what happened to Flamengo?", [
      { role: "system", content: "x" },
      { role: "user", content: "were there cup games yesterday?" },
      { role: "assistant", content: "No, none were played." },
      { role: "user", content: "what happened to Flamengo?" },
    ]);
    assert.deepEqual(out, { query: "what happened to Flamengo?", via: "words", added: [] });
  });
});
