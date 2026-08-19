import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-route-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
// The bundled skills live in the checkout now, so a suite that redirects
// only the data dir would still load them into every prompt it measures.
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
// Machine-wide state (model choice, desktop-control consent) must never be
// read from or written to the developer's real machine by a test.
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_MCP_CONFIG = join(scratch, "none.json");
process.env.ENIO_ROUTING = "1";

const { route, DEFAULT_SPECIALIST } = await import("./specialists.js");
const { runTurn } = await import("./agent.js");
const { buildRegistry } = await import("./tools/index.js");
const store = await import("./memory/store.js");
const { closeDb } = await import("./memory/db.js");
import type { Message } from "./types.js";

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

/** Reply with a fixed content string to every model call. */
function stubReply(...contents: string[]) {
  const queue = [...contents];
  globalThis.fetch = (async () => {
    const content = queue.length > 1 ? queue.shift()! : queue[0] ?? "";
    const frame = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
    return new Response(
      new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode(frame));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

describe("router", () => {
  test("parses a clean JSON decision", async () => {
    stubReply('{"specialist": "researcher"}');
    assert.equal(await route("what happened at WWDC this year"), "researcher");
  });

  test("tolerates surrounding prose", async () => {
    stubReply('Sure thing!\n{"specialist": "coder"}\nHope that helps.');
    assert.equal(await route("why does my build fail with TS2307"), "coder");
  });

  test("salvages a bare specialist name when JSON is malformed", async () => {
    // The common small-model failure: right answer, wrong envelope.
    stubReply("I think this should go to the librarian.");
    assert.equal(await route("what did I tell you about my setup"), "librarian");
  });

  test("falls back to the generalist on an unknown name", async () => {
    stubReply('{"specialist": "database_admin"}');
    assert.equal(await route("some request that is long enough to route"), DEFAULT_SPECIALIST);
  });

  test("falls back when the model errors entirely", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    assert.equal(await route("a request long enough to trigger routing"), DEFAULT_SPECIALIST);
  });

  test("skips the extra call for very short inputs", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    assert.equal(await route("hi"), DEFAULT_SPECIALIST);
    assert.equal(called, false, "a greeting should not cost a routing call");
  });

  test("a one-word input sticks without a routing call", async () => {
    // One word is a greeting or an acknowledgement; several words is a small
    // command. "open notes" routed by length alone stuck to a TCP chat's
    // generalist, so only the one-word case skips the router now.
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    assert.equal(await route("ok", "operator"), "operator");
    assert.equal(called, false, "an acknowledgement should not cost a routing call");
  });

  test("a multi-word follow-up consults the router, with the conversation as context", async () => {
    // The router sees "handled by operator" in its prompt and the reply keeps
    // it there; measured live, "try again" stays and "open notes" switches.
    stubReply('{"specialist": "operator"}');
    assert.equal(await route("try again", "operator"), "operator");
  });

  test("a stale specialist name from the database is not trusted", async () => {
    // The column outlives renames of the specialists themselves.
    stubReply('{"specialist": "researcher"}');
    assert.equal(await route("hm", "assistant_v1"), DEFAULT_SPECIALIST);
  });

  test("a router error falls back to the conversation, then the default", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    assert.equal(
      await route("a request long enough to trigger routing", "mail"),
      "mail",
      "an errored router knows nothing; the history knows something",
    );
  });
});

describe("routing inside a turn", () => {
  test("reports the chosen specialist and narrows the tools", async () => {
    // First call is the router, second is the specialist answering.
    stubReply('{"specialist": "researcher"}', "Here is what I found.");

    const registry = await buildRegistry();
    const sessionId = store.startSession();
    const history: Message[] = [];
    let routed = "";

    const result = await runTurn(
      "what is the current state of ternary quantisation research",
      history,
      registry,
      sessionId,
      { onRoute: (s) => { routed = s; } },
    );

    assert.equal(routed, "researcher");
    assert.equal(result.specialist, "researcher");

    // The system prompt should carry the researcher's instructions, not the
    // generic ones — this is what actually changes behaviour.
    const system = String(history[0]?.content ?? "");
    assert.match(system, /You research things and report what you find/i);

    // Matched against the coder's own opening line rather than the word
    // "workspace". The bare noun was a proxy for the coder's framing, and it
    // stopped being one when a shared rule started mentioning the workspace
    // legitimately — the fs tools are scoped to it for every specialist, so
    // the word belongs to all of them and identifies none.
    assert.ok(
      !/you work with code in the user's workspace/i.test(system),
      "should not carry the coder's framing",
    );
  });

  test("returns the question so the caller can save it as an exemplar", async () => {
    stubReply('{"specialist": "generalist"}', "An answer.");
    const registry = await buildRegistry();
    const sessionId = store.startSession();
    const result = await runTurn("explain what a monad is", [], registry, sessionId);
    assert.equal(result.question, "explain what a monad is");
  });
});
