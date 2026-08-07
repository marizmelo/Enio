import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "maple-int-"));
process.env.MAPLE_DATA_DIR = join(scratch, "data");
process.env.MAPLE_WORKSPACE = join(scratch, "workspace");
process.env.MAPLE_MCP_CONFIG = join(scratch, "no-such-mcp.json");
// These exercise the tool loop itself. Routing adds a model call in front of
// every turn, which would consume the scripted responses below; it has its own
// tests in learning.test.ts and routing.test.ts.
process.env.MAPLE_ROUTING = "0";

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
    let notice = "";
    const result = await runTurn("loop forever", history, registry, sessionId, {
      onNotice: (t) => { notice = t; },
    });

    assert.match(notice, /Stopped after/);
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
