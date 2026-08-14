import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-revise-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
// The bundled skills live in the checkout now, so a suite that redirects
// only the data dir would still load them into every prompt it measures.
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

const { revisePlan } = await import("./revise.js");

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  rmSync(scratch, { recursive: true, force: true });
});

/** One streamed content chunk, the shape the model client consumes. */
function stubReply(content: string) {
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200 },
    )) as typeof fetch;
}

const BASE = [{ summary: "count", script: "return 1", kind: "applescript" as const }];

describe("revising a plan by prompt", () => {
  test("parses a clean array and keeps the kinds", async () => {
    stubReply('[{"summary":"count","script":"print(1)","kind":"python"}]');
    const out = await revisePlan(BASE, "use python", "counting");
    assert.ok(out.ok);
    assert.deepEqual(out.steps, [{ summary: "count", script: "print(1)", kind: "python" }]);
  });

  test("tolerates prose and a fence around the array", async () => {
    // The commonest small-model failure is the right answer in the wrong
    // envelope, which is already true of tool calls and is true here too.
    stubReply('Sure!\n```json\n[{"summary":"a","script":"echo hi","kind":"shell"}]\n```\nHope that helps.');
    const out = await revisePlan(BASE, "use shell", "x");
    assert.ok(out.ok);
    assert.equal(out.steps![0]!.kind, "shell");
    assert.equal(out.steps![0]!.script, "echo hi");
  });

  test("an unknown kind falls back rather than reaching an interpreter", async () => {
    // kind decides which binary runs the script, so an invented one must not
    // survive into execution.
    stubReply('[{"summary":"a","script":"echo hi","kind":"ruby"}]');
    const out = await revisePlan(BASE, "x", "x");
    assert.ok(out.ok);
    assert.equal(out.steps![0]!.kind, "applescript");
  });

  test("steps with no script are dropped, and an all-empty revision is refused", async () => {
    stubReply('[{"summary":"real","script":"echo hi","kind":"shell"},{"summary":"empty","script":"  "}]');
    let out = await revisePlan(BASE, "x", "x");
    assert.ok(out.ok);
    assert.equal(out.steps!.length, 1);

    stubReply('[{"summary":"empty","script":""}]');
    out = await revisePlan(BASE, "x", "x");
    assert.equal(out.ok, false);
  });

  test("a reply with no array is refused rather than guessed at", async () => {
    stubReply("I would change the second step to use Python.");
    const out = await revisePlan(BASE, "x", "x");
    assert.equal(out.ok, false);
    assert.match(String(out.reason), /did not return a list/);
  });

  test("an empty instruction never reaches the model", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const out = await revisePlan(BASE, "   ", "x");
    assert.equal(out.ok, false);
    assert.equal(called, false, "an empty instruction should cost no model call");
  });

  test("a model error is reported, not thrown", async () => {
    // The sheet stays usable and the plan stays pending: a failed rewrite
    // must cost a glance, not the plan.
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const out = await revisePlan(BASE, "use python", "x");
    assert.equal(out.ok, false);
    assert.ok(out.reason);
  });
});
