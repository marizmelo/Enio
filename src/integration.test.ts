import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-int-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-such-mcp.json");
// These exercise the tool loop itself. Routing adds a model call in front of
// every turn, which would consume the scripted responses below; it has its own
// tests in learning.test.ts and routing.test.ts.
process.env.ENIO_ROUTING = "0";

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

/** Queue of scripted model responses; each call to the model pops one. */
function scriptModel(turns: Array<{ content?: string; toolCall?: { name: string; args: unknown } }>) {
  const queue = [...turns];
  globalThis.fetch = (async () => {
    const turn = queue.shift() ?? { content: "(exhausted)" };
    const frames: string[] = [];
    if (turn.content) {
      frames.push(
        `data: ${JSON.stringify({ choices: [{ delta: { content: turn.content } }] })}\n\n`,
      );
    }
    if (turn.toolCall) {
      frames.push(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_x",
                    function: {
                      name: turn.toolCall.name,
                      arguments: JSON.stringify(turn.toolCall.args),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
    }
    frames.push("data: [DONE]\n\n");
    return new Response(
      new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          for (const f of frames) c.enqueue(enc.encode(f));
          c.close();
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

describe("agent loop end to end", () => {
  test("executes a tool, feeds the result back, and answers", async () => {
    const registry = await buildRegistry();
    const sessionId = store.startSession();

    scriptModel([
      { content: "Let me write that.", toolCall: { name: "write_file", args: { path: "hello.txt", content: "hi there" } } },
      { toolCall: { name: "read_file", args: { path: "hello.txt" } } },
      { content: "The file says: hi there" },
    ]);

    const history: Message[] = [];
    const seen: string[] = [];
    const result = await runTurn("create hello.txt then read it", history, registry, sessionId, {
      onToolStart: (name) => seen.push(name),
    });

    assert.deepEqual(seen, ["write_file", "read_file"]);
    assert.match(result.reply, /hi there/);

    // The transcript must contain the tool round-trips, not just the final text —
    // Maple's template needs assistant tool_calls paired with tool results.
    const toolMessages = history.filter((m) => m.role === "tool");
    assert.equal(toolMessages.length, 2);
    assert.match(String(toolMessages[1]!.content), /hi there/);
  });

  test("recovers from a hallucinated tool name by listing real ones", async () => {
    const registry = await buildRegistry();
    const sessionId = store.startSession();

    scriptModel([
      { toolCall: { name: "definitely_not_a_tool", args: {} } },
      { content: "Sorry, used the wrong tool. Done now." },
    ]);

    const history: Message[] = [];
    const result = await runTurn("do something", history, registry, sessionId);

    const toolResult = String(history.find((m) => m.role === "tool")?.content ?? "");
    assert.match(toolResult, /No tool named "definitely_not_a_tool"/);
    assert.match(toolResult, /Available tools:/);
    assert.match(result.reply, /Done now/);
  });

  test("reports missing required arguments instead of throwing", async () => {
    const registry = await buildRegistry();
    const sessionId = store.startSession();

    scriptModel([
      { toolCall: { name: "write_file", args: { path: "x.txt" } } }, // no content
      { content: "Fixed." },
    ]);

    const history: Message[] = [];
    await runTurn("write a file", history, registry, sessionId);
    const toolResult = String(history.find((m) => m.role === "tool")?.content ?? "");
    assert.match(toolResult, /Missing required argument.*content/);
  });

  test("a sandbox escape is refused and reported back to the model", async () => {
    const registry = await buildRegistry();
    const sessionId = store.startSession();

    scriptModel([
      { toolCall: { name: "read_file", args: { path: "../../../../etc/passwd" } } },
      { content: "Understood, that's out of bounds." },
    ]);

    const history: Message[] = [];
    await runTurn("read the password file", history, registry, sessionId);
    const toolResult = String(history.find((m) => m.role === "tool")?.content ?? "");
    assert.match(toolResult, /escapes the workspace/);
  });

  test("stops looping when the model never stops calling tools", async () => {
    const registry = await buildRegistry();
    const sessionId = store.startSession();

    // Always returns a tool call; only the forced final iteration ends it.
    scriptModel(
      Array.from({ length: 20 }, () => ({
        toolCall: { name: "list_dir", args: { path: "." } },
      })),
    );

    const history: Message[] = [];
    const notices: string[] = [];
    const result = await runTurn("loop forever", history, registry, sessionId, {
      onNotice: (t) => notices.push(t),
    });

    // Collected rather than last-wins: the empty-reply retry may add its own
    // notice after this one, and both are correct.
    assert.ok(notices.some((t) => /Stopped after/.test(t)), notices.join(" | "));
    // Bounded, and it returned rather than hanging.
    assert.ok(result.toolsUsed.length <= 8);
  });

  test("remember writes through to searchable memory", async () => {
    const registry = await buildRegistry();
    const sessionId = store.startSession();

    scriptModel([
      { toolCall: { name: "remember", args: { fact: "Mariz uses a Mac mini for local models", important: true } } },
      { content: "Noted." },
    ]);

    const history: Message[] = [];
    await runTurn("remember that I use a Mac mini for local models", history, registry, sessionId);

    const hits = await store.searchFacts("Mac mini");
    assert.ok(hits.some((h) => h.text.includes("Mac mini")), "fact should be retrievable");
  });
});

describe("widget channel", () => {
  test("a tool's widget reaches the handler while its text reaches the model", async () => {
    // The clock is the shipped example, but the property under test is the
    // contract, not the tool: text is the answer, the widget is a second view
    // of the same answer. A client that cannot draw must lose nothing, which is
    // what makes the CLI need no fallback code at all.
    scriptModel([
      { toolCall: { name: "current_time", args: {} } },
      { content: "Told you." },
    ]);

    const registry = await buildRegistry();
    const sessionId = store.startSession();
    const history: Message[] = [];
    const widgets: unknown[] = [];
    await runTurn("what time is it", history, registry, sessionId, {
      onWidget: (w) => widgets.push(w),
    });

    assert.equal(widgets.length, 1, "the widget should have been emitted once");
    assert.equal((widgets[0] as { type: string }).type, "clock");

    // The same answer must be in the tool message the model reads, in words.
    const toolMessage = history.find((m) => m.role === "tool");
    assert.ok(toolMessage, "the tool result must be in the transcript");
    assert.match(String(toolMessage!.content), /^It is .+\(.+\)\.$/);
  });

  test("a tool returning a bare string emits no widget", async () => {
    // Every existing tool returns a string. Nothing may start emitting widgets
    // by accident, or the channel stops meaning anything.
    scriptModel([
      { toolCall: { name: "read_file", args: { path: "hello.txt" } } },
      { content: "Read it." },
    ]);

    const registry = await buildRegistry();
    const sessionId = store.startSession();
    const widgets: unknown[] = [];
    await runTurn("read hello.txt", [], registry, sessionId, {
      onWidget: (w) => widgets.push(w),
    });

    assert.equal(widgets.length, 0);
  });
});

describe("history compaction", () => {
  test("folds older turns into a summary and keeps recent ones verbatim", async () => {
    // The summariser is the first model call; the answer is the second.
    scriptModel([
      { content: "Notes: user is deploying acme-api. Prefers short answers." },
      { content: "Understood." },
    ]);

    const registry = await buildRegistry();
    const sessionId = store.startSession();

    // Comfortably past the window, so compaction has to happen.
    const history: Message[] = [];
    for (let i = 0; i < 60; i++) {
      history.push({ role: "user", content: `question ${i}` });
      history.push({ role: "assistant", content: `answer ${i}` });
    }

    await runTurn("and now?", history, registry, sessionId);

    // The array the caller owns is compacted in place. Left whole, it would be
    // sent back in full next turn and undo the work immediately.
    const summary = history.find(
      (m) => m.role === "system" && String(m.content).startsWith("Earlier in this conversation:"),
    );
    assert.ok(summary, "the older turns should be folded into a summary");
    assert.match(String(summary!.content), /acme-api/);

    // The most recent exchange has to survive untouched: a summary cannot
    // resolve what "it" refers to in the next question.
    assert.ok(
      history.some((m) => m.content === "answer 59"),
      "the newest turns must be kept verbatim",
    );
    assert.ok(
      !history.some((m) => m.content === "answer 0"),
      "the oldest turns should be gone, not merely appended to",
    );
  });

  test("keeps a short conversation exactly as it is", async () => {
    // Nothing to fold means no summariser call, so a single scripted reply is
    // all this should consume. A second call would mean it compacted anyway.
    scriptModel([{ content: "Fine." }]);

    const registry = await buildRegistry();
    const sessionId = store.startSession();
    const history: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    await runTurn("still there?", history, registry, sessionId);

    assert.ok(
      !history.some((m) => String(m.content).startsWith("Earlier in this conversation:")),
      "a short conversation must not be summarised",
    );
    assert.ok(history.some((m) => m.content === "hello"));
  });
});

describe("empty-reply recovery", () => {
  test("a turn that thought itself to death is retried without thinking", async () => {
    // First call: the model burned its budget in <think> and produced nothing.
    // Second call: the retry, which must decline thinking through the template.
    const bodies: any[] = [];
    let call = 0;
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      call += 1;
      const frames: string[] = [];
      if (call === 1) {
        frames.push(
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "thinking forever" } }] })}\n\n`,
        );
      } else {
        frames.push(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Here is the answer." } }] })}\n\n`,
        );
      }
      frames.push("data: [DONE]\n\n");
      return new Response(
        new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            for (const f of frames) c.enqueue(enc.encode(f));
            c.close();
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const registry = await buildRegistry();
    const sessionId = store.startSession();
    const history: Message[] = [];
    const notices: string[] = [];

    const result = await runTurn("a hard question", history, registry, sessionId, {
      onNotice: (t) => notices.push(t),
    });

    assert.equal(result.reply, "Here is the answer.");
    assert.equal(
      bodies[1]?.chat_template_kwargs?.enable_thinking,
      false,
      "the retry must decline thinking through the template",
    );
    assert.equal(
      bodies[0]?.chat_template_kwargs,
      undefined,
      "the first attempt must think normally",
    );
    assert.ok(notices.length > 0, "the wait for a second attempt should be explained");

    // The empty assistant turn is replaced, not left in front of the answer:
    // a blank message in history reads as the model having said nothing.
    const assistants = history.filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0]!.content, "Here is the answer.");
  });

  test("two blank attempts produce an honest sentence, not silence", async () => {
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;

    const registry = await buildRegistry();
    const sessionId = store.startSession();
    const history: Message[] = [];

    const result = await runTurn("another hard question", history, registry, sessionId);

    assert.match(result.reply, /ran out of room twice/);
    // The transcript carries the explanation too, so the next turn's context
    // shows what happened rather than an inexplicable gap.
    const last = history[history.length - 1];
    assert.equal(last?.role, "assistant");
    assert.match(String(last?.content), /ran out of room twice/);
  });
});
