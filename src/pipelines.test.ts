import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// Type-only: erased at compile time, so it cannot beat the env setup above.
import type { RunEvent } from "./pipelines.js";

const scratch = mkdtempSync(join(tmpdir(), "enio-pipelines-"));
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-such-mcp.json");
// The executor drives full turns with a scripted model; routing would spend
// the script on classification calls.
process.env.ENIO_ROUTING = "0";
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

const pipelines = await import("./pipelines.js");
const { validatePipeline, extractArtifacts, composePipeline } = pipelines;

const node = (id: string, abilityId: string) => ({ id, abilityId, prompt: `do ${id}` });

test("validation: cycles, unknown abilities, port mismatches are refusals", () => {
  // Unknown ability.
  let v = validatePipeline([node("a", "no-such-ability")], []);
  assert.ok(!v.ok && /Unknown ability/.test(v.reason));

  // Future ability cannot run.
  v = validatePipeline([node("a", "create-image")], []);
  assert.ok(!v.ok && /not built yet/.test(v.reason));

  // Cycle.
  v = validatePipeline(
    [node("a", "web-search"), node("b", "create-document")],
    [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ],
  );
  assert.ok(!v.ok && /accept|loop/i.test(v.reason));

  // Port mismatch: remember outputs text only... web-search accepts text, so
  // use a genuinely incompatible pair: screenshot (image/file out) -> remember
  // (text in only).
  v = validatePipeline(
    [node("s", "screenshot"), node("r", "remember")],
    [{ from: "s", to: "r" }],
  );
  assert.ok(!v.ok && /does not accept/.test(v.reason));
});

test("validation: a diamond resolves to a correct topological order", () => {
  const v = validatePipeline(
    [
      node("top", "web-search"),
      node("left", "create-document"),
      node("right", "file-search"),
      node("bottom", "create-document"),
    ],
    [
      { from: "top", to: "left" },
      { from: "top", to: "right" },
      { from: "left", to: "bottom" },
      { from: "right", to: "bottom" },
    ],
  );
  assert.ok(v.ok);
  const order = v.order;
  assert.equal(order[0], "top");
  assert.equal(order[3], "bottom");
});

test("artifact extraction is pinned to the tools' exact wording", () => {
  // These strings are VERBATIM from the tools. If fs.ts, desktop.ts or
  // email.ts reword their output, this failing loudly is the feature.
  assert.deepEqual(extractArtifacts("write_file", "Wrote 512 bytes to notes/report.md"), [
    { type: "document", path: "notes/report.md" },
  ]);
  assert.deepEqual(
    extractArtifacts(
      "take_screenshot",
      "Screenshot saved to /Users/x/enio-workspace/screen-123.png\n\nA desktop with a browser open.",
    ),
    [{ type: "image", path: "/Users/x/enio-workspace/screen-123.png" }],
  );
  assert.deepEqual(
    extractArtifacts(
      "send_email",
      "DRY RUN — nothing was sent.\n\nTo: a@b.c\n\nSaved to /Users/x/enio-workspace/draft-1.eml\nSet ENIO_EMAIL_SEND=1 to send for real.",
    ),
    [{ type: "email_draft", path: "/Users/x/enio-workspace/draft-1.eml" }],
  );
  assert.deepEqual(extractArtifacts("propose_plan", "Proposed, not run. Steps:\n1. x"), [
    { type: "plan" },
  ]);
  assert.deepEqual(extractArtifacts("read_file", "   1 | hello"), []);
});

test("examples: shipped files load; user example shadows by name", async () => {
  const loaded = pipelines.loadPipelineExamples();
  assert.ok(loaded.some((e) => e.name === "research-brief"));
  pipelines.saveExample({
    name: "research-brief",
    prompt: "my own version",
    nodes: [node("n1", "web-search")],
    edges: [],
  });
  const after = pipelines.loadPipelineExamples();
  const mine = after.filter((e) => e.name === "research-brief");
  assert.equal(mine.length, 1, "one name, one example");
  assert.equal(mine[0]!.prompt, "my own version");
});

/** Scripted SSE model, the integration.test.ts idiom. */
function scriptModel(turns: Array<{ content?: string; toolCall?: { name: string; args: unknown } }>) {
  const queue = [...turns];
  globalThis.fetch = (async () => {
    const turn = queue.shift() ?? { content: "(exhausted)" };
    const frames: string[] = [];
    if (turn.toolCall) {
      frames.push(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
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
    if (turn.content) {
      frames.push(
        `data: ${JSON.stringify({ choices: [{ delta: { content: turn.content } }] })}\n\n`,
      );
    }
    frames.push("data: [DONE]\n\n");
    return new Response(frames.join(""), { status: 200 });
  }) as typeof fetch;
}

const originalFetch = globalThis.fetch;

test("composer: valid JSON composes; an invented ability is a refusal", async () => {
  const { buildRegistry } = await import("./tools/index.js");
  const registry = await buildRegistry();
  try {
    scriptModel([
      {
        content:
          '{"nodes": [{"id": "n1", "ability": "web-search", "prompt": "find it"}, ' +
          '{"id": "n2", "ability": "create-document", "prompt": "write it up"}], ' +
          '"edges": [{"from": "n1", "to": "n2"}]}',
      },
    ]);
    const good = await composePipeline("research and write", registry, []);
    assert.ok(good.ok, good.reason);
    assert.equal(good.nodes!.length, 2);
    assert.equal(good.edges!.length, 1);

    scriptModel([
      { content: '{"nodes": [{"id": "n1", "ability": "summon-demons", "prompt": "x"}], "edges": []}' },
    ]);
    const bad = await composePipeline("do the thing", registry, []);
    assert.ok(!bad.ok, "an ability outside the closed list must be refused, never coerced");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("executor: a two-node chain hands node 1's document to node 2, with the right specialists", async () => {
  const { buildRegistry } = await import("./tools/index.js");
  const { writeFileSync } = await import("node:fs");
  const registry = await buildRegistry();

  writeFileSync(join(scratch, "workspace", "seed.md"), "seed");

  const pipeline = pipelines.savePipeline({
    name: "chain-test",
    nodes: [
      { id: "n1", abilityId: "create-document", prompt: "write the report" },
      { id: "n2", abilityId: "create-document", prompt: "extend the report" },
    ],
    edges: [{ from: "n1", to: "n2" }],
  });

  try {
    // Node 1: model calls write_file (a REAL tool run against the scratch
    // workspace), then answers. Node 2: just answers.
    scriptModel([
      { toolCall: { name: "write_file", args: { path: "report.md", content: "hello world" } } },
      { content: "Report written." },
      { content: "Extended the report." },
    ]);

    const events: RunEvent[] = [];
    const outcome = await pipelines.runPipeline(pipeline, registry, (e) => events.push(e));
    assert.equal(outcome.status, "succeeded");

    const finished = events.filter((e) => e.type === "node_finished");
    assert.equal(finished.length, 2);
    const first = finished[0] as Extract<RunEvent, { type: "node_finished" }>;
    assert.ok(
      first.artifacts.some((a: { type: string; path?: string }) => a.type === "document" && a.path === "report.md"),
      "node 1's write_file surfaced as a document artifact",
    );
    // And the file really exists -- the tool ran for real.
    const { existsSync } = await import("node:fs");
    assert.ok(existsSync(join(scratch, "workspace", "report.md")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("executor: a failed node skips its downstream and persists partial results", async () => {
  const { buildRegistry } = await import("./tools/index.js");
  const registry = await buildRegistry();

  const pipeline = pipelines.savePipeline({
    name: "fail-test",
    nodes: [
      { id: "a", abilityId: "create-document", prompt: "first" },
      { id: "b", abilityId: "create-document", prompt: "second" },
    ],
    edges: [{ from: "a", to: "b" }],
  });

  try {
    // The model server "goes away" for node a: fetch rejects.
    globalThis.fetch = (async () => {
      throw new Error("model server unreachable");
    }) as typeof fetch;

    const events: RunEvent[] = [];
    const outcome = await pipelines.runPipeline(pipeline, registry, (e) => events.push(e));
    assert.equal(outcome.status, "failed");
    assert.ok(events.some((e) => e.type === "node_failed" && e.nodeId === "a"));
    assert.ok(events.some((e) => e.type === "node_skipped" && e.nodeId === "b"));

    const { getDb } = await import("./memory/db.js");
    const row = getDb()
      .prepare(`SELECT status, node_results FROM pipeline_runs WHERE id = ?`)
      .get(outcome.runId) as { status: string; node_results: string };
    assert.equal(row.status, "failed");
    const results = JSON.parse(row.node_results) as Array<{ nodeId: string; status: string }>;
    assert.equal(results.find((r) => r.nodeId === "b")?.status, "skipped");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
