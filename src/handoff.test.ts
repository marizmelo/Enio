import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-handoff-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
// The bundled skills live in the checkout now, so a suite that redirects
// only the data dir would still load them into every prompt it measures.
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-such-mcp.json");
process.env.ENIO_ROUTING = "0";

const { runTurn } = await import("./agent.js");
const { buildRegistry } = await import("./tools/index.js");
const store = await import("./memory/store.js");
const { closeDb } = await import("./memory/db.js");
import type { Skill } from "./skills.js";

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

/** The integration.test.ts stub, reduced to content-only turns. */
function scriptModel(replies: string[]) {
  const queue = [...replies];
  globalThis.fetch = (async () => {
    const content = queue.shift() ?? "(exhausted)";
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
      { status: 200 },
    );
  }) as typeof fetch;
}

const handoffSkill: Skill = {
  name: "ask-bigger-model",
  description: "test stand-in",
  dir: scratch,
  body: "compose a handoff",
  allowedTools: null,
  agents: null,
  manualOnly: false,
  origin: "global",
  overridesBuiltin: false,
};

const workspace = () => process.env.ENIO_WORKSPACE!;

describe("handoff turns persist through the harness, not the model", () => {
  // The failure this guards: asked live, the 4B composed the prompt in chat
  // and skipped write_file; asked again it composed the prompt and CLAIMED
  // "File saved" with zero tool calls. The reply is the handoff; saving it
  // is the harness's job.
  test("a compose-only reply becomes a file named from its topic line", async () => {
    const registry = await buildRegistry();
    const sessionId = store.startSession();
    scriptModel([
      "# Handoff: Lease Deposit Review\n\nThe task: find the deposit.\n\nPaste this into your AI of choice.",
    ]);
    const result = await runTurn("package this", [], registry, sessionId, {}, {
      skills: [handoffSkill],
    });
    assert.equal(result.handoffFile, "handoff-lease-deposit-review.md");
    const saved = readFileSync(join(workspace(), result.handoffFile!), "utf8");
    assert.match(saved, /# Handoff: Lease Deposit Review/);
    assert.match(saved, /find the deposit/);
  });

  test("a filename the reply claims is honored, so the text stays true", async () => {
    const registry = await buildRegistry();
    const sessionId = store.startSession();
    scriptModel(["The prompt is ready.\n\nFile saved: handoff-memo.md"]);
    const result = await runTurn("package this", [], registry, sessionId, {}, {
      skills: [handoffSkill],
    });
    assert.equal(result.handoffFile, "handoff-memo.md");
    assert.ok(existsSync(join(workspace(), "handoff-memo.md")));
  });

  test("a second save with the same name dedupes instead of overwriting", async () => {
    const registry = await buildRegistry();
    const sessionId = store.startSession();
    scriptModel(["Ready.\n\nFile saved: handoff-memo.md"]);
    const result = await runTurn("package this again", [], registry, sessionId, {}, {
      skills: [handoffSkill],
    });
    assert.equal(result.handoffFile, "handoff-memo-2.md");
  });

  test("a single outer fence is unwrapped as wrapping, not content", async () => {
    const registry = await buildRegistry();
    const sessionId = store.startSession();
    scriptModel(["```markdown\n# Handoff: Fenced Case\n\nBody here.\n```"]);
    const result = await runTurn("package this", [], registry, sessionId, {}, {
      skills: [handoffSkill],
    });
    const saved = readFileSync(join(workspace(), result.handoffFile!), "utf8");
    assert.ok(!saved.includes("```"), "fence stripped");
    assert.match(saved, /^# Handoff: Fenced Case/);
  });

  test("a turn without the skill saves nothing", async () => {
    const registry = await buildRegistry();
    const sessionId = store.startSession();
    scriptModel(["# Handoff: Should Not Persist\n\nJust an answer that looks like one."]);
    const result = await runTurn("ordinary question", [], registry, sessionId, {}, {});
    assert.equal(result.handoffFile, undefined);
    assert.ok(!existsSync(join(workspace(), "handoff-should-not-persist.md")));
  });

  test("a model that wrote the file itself is left alone", async () => {
    const registry = await buildRegistry();
    const sessionId = store.startSession();
    // First model turn calls write_file for a handoff; second closes out.
    const frames = [
      {
        toolCall: {
          name: "write_file",
          args: { path: "handoff-self.md", content: "# Handoff: Self\n\nBody." },
        },
      },
      { content: "Saved to handoff-self.md." },
    ];
    const queue = [...frames];
    globalThis.fetch = (async () => {
      const turn = queue.shift() ?? { content: "(exhausted)" };
      const out: string[] = [];
      if ("content" in turn && turn.content) {
        out.push(`data: ${JSON.stringify({ choices: [{ delta: { content: turn.content } }] })}\n\n`);
      }
      if ("toolCall" in turn && turn.toolCall) {
        out.push(
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
      out.push("data: [DONE]\n\n");
      return new Response(
        new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            for (const f of out) c.enqueue(enc.encode(f));
            c.close();
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await runTurn("package this", [], registry, sessionId, {}, {
      skills: [handoffSkill],
    });
    assert.equal(result.handoffFile, undefined, "harness does not double-save");
    const saved = readFileSync(join(workspace(), "handoff-self.md"), "utf8");
    assert.match(saved, /# Handoff: Self/);
  });
});

test("a restored conversation keeps the handoff artifact without inventing a tool badge", async () => {
  const registry = await buildRegistry();
  const sessionId = store.startSession();
  scriptModel(["# Handoff: Restored Case\n\nBody."]);
  const result = await runTurn("package this", [], registry, sessionId, {}, {
    skills: [handoffSkill],
  });
  assert.ok(result.handoffFile);
  const restored = store.conversationMessages(sessionId);
  const reply = restored.find((m) => m.role === "assistant");
  assert.ok(
    reply?.artifacts?.some((a) => a.path === result.handoffFile),
    "artifact re-derived from the trace",
  );
  assert.ok(!(reply?.tools ?? []).includes("handoff_saved"), "no invented tool badge");
});
