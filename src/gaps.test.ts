import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-gaps-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");

import type { TurnOutcome } from "./memory/gaps.js";
const gaps = await import("./memory/gaps.js");
const { rememberFact, resetDerived } = await import("./memory/store.js");
const { recordTurn } = await import("./memory/traces.js");
const { closeDb } = await import("./memory/db.js");

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

const outcome = (over: Partial<TurnOutcome> = {}): TurnOutcome => ({
  question: "when is the Halvorsen contract renewal?",
  specialist: "generalist",
  basis: "model",
  toolNames: [],
  skillsInvoked: false,
  at: 1_000,
  ...over,
});

describe("the gap ledger", () => {
  test("a question nothing covered is a gap; anything the turn answered from is not", () => {
    assert.equal(gaps.isGap(outcome()), true);
    assert.equal(gaps.isGap(outcome({ basis: "memory" })), false, "memory covered it");
    assert.equal(gaps.isGap(outcome({ basis: "conversation" })), false, "this thread covered it");
    assert.equal(gaps.isGap(outcome({ basis: "web" })), false, "a search answered it");
    assert.equal(gaps.isGap(outcome({ basis: "files" })), false, "a file answered it");
  });

  test("greetings, skill turns, the coder, and tool-answered turns are not gaps", () => {
    assert.equal(gaps.isGap(outcome({ question: "thanks!" })), false);
    assert.equal(gaps.isGap(outcome({ question: "ok" })), false);
    assert.equal(gaps.isGap(outcome({ skillsInvoked: true })), false, "the skill may have been the answer");
    assert.equal(gaps.isGap(outcome({ specialist: "coder" })), false, "file work is not knowledge");
    assert.equal(gaps.isGap(outcome({ toolNames: ["weather"] })), false, "a lookup answered it");
    assert.equal(gaps.isGap(outcome({ toolNames: ["recall"] })), true, "a recall that found nothing is the gap itself");
  });

  test("the same terms asked again bump the count, not the rows", () => {
    assert.equal(gaps.noteTurn(outcome()), true);
    assert.equal(gaps.noteTurn(outcome({ question: "Halvorsen contract — renewal when?", at: 2_000 })), true);
    const open = gaps.openGaps();
    assert.equal(open.length, 1);
    assert.equal(open[0]!.count, 2);
    assert.equal(open[0]!.lastAt, 2_000);
    assert.equal(open[0]!.key, "contract halvorsen renewal", "sorted terms, so phrasings share a key");
  });

  test("a later fact carrying every term resolves it — as words, not substrings", async () => {
    gaps.noteTurn(outcome({ question: "which port does the staging server use?", at: 3_000 }));
    // "airport" contains "port" but is not the word; the gap must stay open.
    let r = await rememberFact("The staging airport shuttle leaves from the server room", { source: "cli" });
    assert.ok(r.stored);
    assert.equal(gaps.openGaps().some((g) => g.key.includes("port")), true, "substring match must not resolve it");

    r = await rememberFact("The staging server uses port 8443", { source: "cli" });
    assert.ok(r.stored);
    const resolved = gaps.listGaps().find((g) => g.key.includes("port"));
    assert.ok(resolved && resolved.resolvedBy !== null, "every word present: resolved");
    assert.equal(gaps.openGaps().some((g) => g.key.includes("port")), false);
  });

  test("asked again after it was resolved, a gap reopens", () => {
    gaps.noteTurn(outcome({ question: "which port does the staging server use?", at: 4_000 }));
    const g = gaps.openGaps().find((g) => g.key.includes("port"));
    assert.ok(g, "reopened");
    assert.equal(g!.count, 2);
  });

  test("forgetting a gap removes the row", () => {
    const g = gaps.openGaps()[0]!;
    assert.equal(gaps.forgetGap(g.id), true);
    assert.equal(gaps.forgetGap(g.id), false);
  });

  test("reindex reproduces the ledger from the traces, and closes what current facts cover", async () => {
    // Three traced turns: a gap, a gap the facts now cover, and a covered one.
    const trace = (q: string, basis: string, extra: Array<{ kind: "tool" | "harness"; name: string }> = []) =>
      recordTurn({
        sessionId: "s",
        question: q,
        reply: "…",
        specialist: "generalist",
        systemPrompt: "",
        memoryBlock: "",
        startedAt: 5_000,
        durationMs: 1,
        iterations: 1,
        steps: [
          ...extra.map((s, i) => ({ seq: i, kind: s.kind, name: s.name, args: "{}" })),
          { seq: 9, kind: "harness" as const, name: "basis", args: JSON.stringify({ basis }) },
        ],
      });
    trace("who owns the Tanaka account?", "model");
    trace("which port does the staging server use?", "model");
    trace("what does Sam work on?", "memory");
    trace("summarise the quarterly deck", "model", [{ kind: "harness", name: "skill_invoked" }]);

    resetDerived();
    assert.equal(gaps.openGaps().length, 0, "derived: gone with the graph");
    const recorded = gaps.rebuildGaps();
    assert.equal(recorded, 2, "two model-basis questions without a skill");
    const open = gaps.openGaps();
    assert.deepEqual(open.map((g) => g.key), ["account owns tanaka"], "the port question is covered by the fact remembered earlier");
    assert.ok(gaps.listGaps().find((g) => g.key.includes("port"))?.resolvedBy);
  });
});
