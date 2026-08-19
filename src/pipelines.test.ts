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
// The bundled skills live in the checkout now, so a suite that redirects
// only the data dir would still load them into every prompt it measures.
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
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
  // edit_file speaks the same first line, so the canvas reloads on an edit
  // exactly as it does on a write.
  assert.deepEqual(
    extractArtifacts("edit_file", "Wrote 12 bytes to a/b.ts\nReplaced 1 passage at line 3."),
    [{ type: "document", path: "a/b.ts" }],
  );
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
  // A screenshot may append a note about how it was captured; the path must
  // still be found, or a pipeline step would silently produce no artifact.
  assert.deepEqual(
    extractArtifacts(
      "take_screenshot",
      "Screenshot saved to /Users/x/enio-workspace/screen-9.png\n\n(Captured the whole screen — the frontmost window's bounds were unreadable.)\n\nA browser.",
    ),
    [{ type: "image", path: "/Users/x/enio-workspace/screen-9.png" }],
  );
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

test("a pipeline teaches the composer only after it has run successfully", async () => {
  const { getDb } = await import("./memory/db.js");
  const saved = pipelines.savePipeline({
    name: "teachable-flow",
    description: "gather the facts and write them up",
    nodes: [node("n1", "web-search"), node("n2", "create-document")],
    edges: [{ from: "n1", to: "n2" }],
  });

  // Saved but never run: not an example. An abandoned draft must not shape
  // how the next pipeline gets composed.
  assert.ok(!pipelines.loadPipelineExamples().some((e) => e.name === "teachable-flow"));
  assert.equal(pipelines.hasSuccessfulRun(saved.id), false);

  // A failed run does not vouch either.
  getDb()
    .prepare(
      `INSERT INTO pipeline_runs (id, pipeline_id, started_at, finished_at, status) VALUES ('r-f', ?, 1, 2, 'failed')`,
    )
    .run(saved.id);
  assert.ok(!pipelines.loadPipelineExamples().some((e) => e.name === "teachable-flow"));

  // One green run flips it: the flow becomes few-shot, carrying the compose
  // prompt it was born from.
  getDb()
    .prepare(
      `INSERT INTO pipeline_runs (id, pipeline_id, started_at, finished_at, status) VALUES ('r-s', ?, 3, 4, 'succeeded')`,
    )
    .run(saved.id);
  assert.equal(pipelines.hasSuccessfulRun(saved.id), true);
  const example = pipelines.loadPipelineExamples().find((e) => e.name === "teachable-flow");
  assert.ok(example, "a succeeded pipeline joins the composer library");
  assert.equal(example!.prompt, "gather the facts and write them up");
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

test("run_pipeline: selection from the vouched list, and never from inside a run", async () => {
  const { buildRegistry } = await import("./tools/index.js");
  const { getDb } = await import("./memory/db.js");
  const registry = await buildRegistry();
  const tool = registry.byName.get("run_pipeline")!;
  assert.ok(tool, "run_pipeline is registered");

  // Vouched target: one node, one green run on record.
  const target = pipelines.savePipeline({
    name: "vouched-target",
    nodes: [node("n1", "prompt")],
    edges: [],
  });
  getDb()
    .prepare(
      `INSERT INTO pipeline_runs (id, pipeline_id, started_at, finished_at, status) VALUES ('rv', ?, 1, 2, 'succeeded')`,
    )
    .run(target.id);

  // Unvouched: saved, never run.
  pipelines.savePipeline({ name: "never-ran", nodes: [node("n1", "prompt")], edges: [] });

  // Unknown and unvouched names are refusals that teach the closed list.
  let out = String(await tool.run({ name: "no-such-flow" }));
  assert.match(out, /No pipeline named/);
  assert.match(out, /vouched-target/, "the refusal lists what IS eligible");
  out = String(await tool.run({ name: "never-ran" }));
  assert.match(out, /No pipeline named/, "an unvouched pipeline is not selectable");

  // A vouched one runs (scripted model answers the single prompt node).
  scriptModel([{ content: "Step handled." }]);
  out = String(await tool.run({ name: "vouched-target" }));
  globalThis.fetch = originalFetch;
  assert.match(out, /"vouched-target" finished/);
  assert.match(out, /Step handled/);

  // Recursion: a pipeline whose node tries to start another pipeline is
  // refused by the tool itself -- compounding hand-offs wearing a different
  // hat. The node's own turn still completes.
  const outer = pipelines.savePipeline({
    name: "outer-flow",
    nodes: [{ id: "n1", abilityId: "prompt", prompt: "start the other one" }],
    edges: [],
  });
  scriptModel([
    { toolCall: { name: "run_pipeline", args: { name: "vouched-target" } } },
    { content: "Could not chain." },
  ]);
  const events: RunEvent[] = [];
  await pipelines.runPipeline(outer, registry, (e) => events.push(e));
  globalThis.fetch = originalFetch;
  const finished = events.find((e) => e.type === "node_finished") as
    | Extract<RunEvent, { type: "node_finished" }>
    | undefined;
  assert.ok(finished, "the outer node still completes");
  // The refusal reached the model as the tool result; the trace of this run
  // must show no second pipeline run started.
  // Two runs on record: the seeded one and the tool-driven one above. The
  // recursion attempt must not have added a third.
  const runs = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM pipeline_runs WHERE pipeline_id = ?`)
    .get(target.id) as { n: number };
  assert.equal(runs.n, 2, "the recursion attempt started no run");
});

test("suggested drafts: mapping is a lookup, duplicates collapse, junk drops", () => {
  // The canonical research turn: search, fetch, write. Fetch collapses into
  // the search step (same ability), leaving a two-step chain.
  let draft = pipelines.draftFromToolSequence(
    "look things up and write them down",
    "ran 4 times",
    ["web_search", "web_fetch", "write_file"],
    "research MLX quantization and write a summary",
  );
  assert.ok(draft);
  assert.deepEqual(
    draft!.nodes.map((n) => n.abilityId),
    ["web-search", "create-document"],
  );
  // The first step carries what was actually asked; edges are a linear chain.
  assert.equal(draft!.nodes[0]!.prompt, "research MLX quantization and write a summary");
  assert.deepEqual(draft!.edges, [{ from: "n1", to: "n2" }]);

  // Unmapped tools drop out; if fewer than two steps survive there is no
  // chain to suggest.
  assert.equal(
    pipelines.draftFromToolSequence("t", "r", ["current_time", "weather", "web_search"]),
    null,
  );

  // Three reads are one file-search step, not three.
  draft = pipelines.draftFromToolSequence("t", "r", [
    "read_file",
    "read_file",
    "list_dir",
    "write_file",
  ]);
  assert.deepEqual(
    draft!.nodes.map((n) => n.abilityId),
    ["file-search", "create-document"],
  );

  // A chain the validator would refuse (screenshot -> remember: no shared
  // port) must not be offered as a draft.
  assert.equal(pipelines.draftFromToolSequence("t", "r", ["take_screenshot", "remember"]), null);
});

test("same-name save updates; renaming onto a taken name is refused", () => {
  const first = pipelines.savePipeline({
    name: "one-name",
    nodes: [node("n1", "prompt")],
    edges: [],
  });
  // No id, same name: the user means the same pipeline. Before this rule
  // every re-save quietly minted another row and by-name lookups became
  // first-match lotteries.
  const again = pipelines.savePipeline({
    name: "one-name",
    nodes: [node("n1", "prompt"), node("n2", "prompt")],
    edges: [{ from: "n1", to: "n2" }],
  });
  assert.equal(again.id, first.id);
  assert.equal(pipelines.listPipelines().filter((p) => p.name === "one-name").length, 1);
  assert.equal(again.nodes.length, 2);

  const other = pipelines.savePipeline({ name: "other-name", nodes: [node("n1", "prompt")], edges: [] });
  assert.throws(
    () => pipelines.savePipeline({ id: other.id, name: "one-name", nodes: other.nodes, edges: [] }),
    /already exists/,
  );
});

test("a running pipeline can be stopped; the run is cancelled, never vouched", async () => {
  const { buildRegistry } = await import("./tools/index.js");
  const registry = await buildRegistry();
  const stoppable = pipelines.savePipeline({
    name: "stoppable-flow",
    nodes: [
      { id: "n1", abilityId: "prompt", prompt: "first" },
      { id: "n2", abilityId: "prompt", prompt: "second" },
    ],
    edges: [{ from: "n1", to: "n2" }],
  });

  // Nothing running yet: a stop is a clean refusal, not a queued intent.
  assert.equal(pipelines.stopPipeline(stoppable.id), false);

  scriptModel([{ content: "step one done" }, { content: "should never stream" }]);
  const events: RunEvent[] = [];
  const result = await pipelines.runPipeline(stoppable, registry, (e) => {
    events.push(e);
    // The user presses Stop while the first node is working.
    if (e.type === "node_started" && e.nodeId === "n1") {
      assert.equal(pipelines.stopPipeline(stoppable.id), true);
    }
  });
  globalThis.fetch = originalFetch;

  assert.equal(result.status, "cancelled");
  assert.ok(events.some((e) => e.type === "node_skipped" && e.nodeId === "n2"));
  assert.equal(pipelines.hasSuccessfulRun(stoppable.id), false, "a stopped run vouches nothing");
});

test("saving after a draft run adopts it, so the pipeline is born vouched", async () => {
  const { getDb } = await import("./memory/db.js");
  // A draft run: pipeline_id points at an ephemeral id no pipelines row has.
  getDb()
    .prepare(
      `INSERT INTO pipeline_runs (id, pipeline_id, started_at, finished_at, status)
       VALUES ('draft-run', 'ephemeral-draft-id', 1, 2, 'succeeded')`,
    )
    .run();
  const saved = pipelines.savePipeline({ name: "born-vouched", nodes: [node("n1", "prompt")], edges: [] });
  assert.equal(pipelines.hasSuccessfulRun(saved.id), false);
  assert.equal(pipelines.adoptRun("draft-run", saved.id), true);
  assert.equal(pipelines.hasSuccessfulRun(saved.id), true);
  // A run that already belongs to a saved pipeline is history, not a
  // transferable credential.
  const other = pipelines.savePipeline({ name: "would-be-thief", nodes: [node("n1", "prompt")], edges: [] });
  assert.equal(pipelines.adoptRun("draft-run", other.id), false);
});

test("a node inherits its ability's MCP server; others get nothing", async () => {
  const { buildRegistry } = await import("./tools/index.js");
  const base = await buildRegistry();
  let toggled = 0;
  const mcpTool: import("./types.js").ToolDef = {
    name: "home__toggle",
    description: "toggle a light",
    parameters: { type: "object", properties: {}, required: [] },
    origin: "mcp",
    server: "home-assistant",
    async run() {
      toggled++;
      return "toggled";
    },
  };
  const registry = {
    all: [...base.all, mcpTool],
    byName: new Map([...base.byName, [mcpTool.name, mcpTool]]),
    dropped: base.dropped,
  };

  // automate-house declares requiredServer "home": its node turns see the
  // connected server's tools even though the operator specialist does not.
  const withServer = pipelines.savePipeline({
    name: "lights-flow",
    nodes: [{ id: "n1", abilityId: "automate-house", prompt: "toggle the light" }],
    edges: [],
  });
  scriptModel([
    { toolCall: { name: "home__toggle", args: {} } },
    { content: "Light toggled." },
  ]);
  let result = await pipelines.runPipeline(withServer, registry, () => {});
  globalThis.fetch = originalFetch;
  assert.equal(result.status, "succeeded");
  assert.equal(toggled, 1, "the MCP tool ran inside the node's turn");

  // An ability with no declaration inherits nothing: the same call is an
  // unknown tool inside a prompt node, and the stub never executes.
  const without = pipelines.savePipeline({
    name: "no-server-flow",
    nodes: [{ id: "n1", abilityId: "prompt", prompt: "toggle the light" }],
    edges: [],
  });
  scriptModel([
    { toolCall: { name: "home__toggle", args: {} } },
    { content: "Could not." },
  ]);
  result = await pipelines.runPipeline(without, registry, () => {});
  globalThis.fetch = originalFetch;
  assert.equal(toggled, 1, "no inheritance without a declared server");
});

test("export as skill: vouched only, parses cleanly, never overwrites", async () => {
  const { getDb } = await import("./memory/db.js");
  const { loadSkills } = await import("./skills.js");
  const pipeline = pipelines.savePipeline({
    name: "Morning News Brief",
    description: "gather AI news and write a brief",
    nodes: [
      { id: "n1", abilityId: "web-search", prompt: "find today's AI news" },
      { id: "n2", abilityId: "create-document", prompt: "write the brief" },
    ],
    edges: [{ from: "n1", to: "n2" }],
  });

  // Unvouched: refused with the run-first message.
  assert.throws(() => pipelines.exportPipelineSkill(pipeline.id), /Run it successfully once/);

  getDb()
    .prepare(
      `INSERT INTO pipeline_runs (id, pipeline_id, started_at, finished_at, status) VALUES ('skill-run', ?, 1, 2, 'succeeded')`,
    )
    .run(pipeline.id);

  const skill = pipelines.exportPipelineSkill(pipeline.id);
  assert.equal(skill.name, "morning-news-brief");

  // The written file must actually load as a skill, or the export is noise.
  const set = loadSkills();
  const loaded = set.skills.find((s) => s.name === "morning-news-brief");
  assert.ok(loaded, `not loaded; problems: ${JSON.stringify(set.problems)}`);
  assert.ok(loaded!.description.length > 0);
  // The exact (spaced) pipeline name is the trigger, steps ride in order.
  assert.ok(loaded!.body.includes('name: "Morning News Brief"'));
  const first = loaded!.body.indexOf("1. Web search");
  const second = loaded!.body.indexOf("2. Create document");
  assert.ok(first > -1 && second > first, loaded!.body);

  // Never overwrites: the skill is the user's document now.
  assert.throws(() => pipelines.exportPipelineSkill(pipeline.id), /already exists/);
});

test("renaming a pipeline cascades to the tasks that reference it by name", async () => {
  const tasks = await import("./tasks.js");
  const saved = pipelines.savePipeline({
    name: "cascade-source",
    nodes: [node("n1", "prompt")],
    edges: [],
  });
  // Both the reserved auto-schedule name and a hand-named CLI task point at
  // the pipeline by NAME; a rename that skipped either would rot it silently
  // until the next fire.
  tasks.addTask({ name: `auto-${saved.id}`, pipeline: "cascade-source", schedule: "0 9 * * *" });
  tasks.addTask({ name: "my-cli-task", pipeline: "cascade-source", schedule: "0 8 * * *" });

  pipelines.savePipeline({
    id: saved.id,
    name: "cascade-renamed",
    nodes: saved.nodes,
    edges: saved.edges,
  });
  assert.equal(tasks.getTask(`auto-${saved.id}`)?.pipeline, "cascade-renamed");
  assert.equal(tasks.getTask("my-cli-task")?.pipeline, "cascade-renamed");

  // Re-saving under the same name touches nothing.
  pipelines.savePipeline({
    id: saved.id,
    name: "cascade-renamed",
    nodes: saved.nodes,
    edges: saved.edges,
  });
  assert.equal(tasks.getTask("my-cli-task")?.pipeline, "cascade-renamed");
  tasks.removeTask("my-cli-task");
  tasks.removeTask(`auto-${saved.id}`);
  pipelines.deletePipeline(saved.id);
});

test("deleting a pipeline takes its schedules and their history with it", async () => {
  const tasks = await import("./tasks.js");
  const { getDb } = await import("./memory/db.js");
  const saved = pipelines.savePipeline({
    name: "doomed-flow",
    nodes: [node("n1", "prompt")],
    edges: [],
  });
  const t = tasks.addTask({
    name: `auto-${saved.id}`,
    pipeline: "doomed-flow",
    schedule: "0 9 * * *",
  });
  getDb()
    .prepare(`INSERT INTO task_runs (task_id, started_at, duration_ms, status) VALUES (?, 1, 5, 'ok')`)
    .run(t.id);

  pipelines.deletePipeline(saved.id);
  assert.equal(tasks.getTask(`auto-${saved.id}`), null, "a schedule without its flow is meaningless");
  const orphaned = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM task_runs WHERE task_id = ?`)
    .get(t.id) as { n: number };
  assert.equal(orphaned.n, 0, "task_runs follow via FK cascade");
});

test("single-agent mode keeps web_search inside the 16-tool ceiling", async () => {
  // This suite runs unrouted (ENIO_ROUTING=0), so buildRegistry caps at 16
  // and truncates the END of the builtin list. Twice now a new builtin has
  // pushed web_search past that edge silently -- the composer then reports
  // "web-search ability does not exist" and nothing else complains. The
  // priority order in tools/index.ts is the fix; this is the alarm.
  const { buildRegistry } = await import("./tools/index.js");
  const registry = await buildRegistry();
  assert.ok(registry.byName.has("web_search"), "web_search must survive the unrouted ceiling");
  assert.ok(registry.byName.has("write_file"));
  assert.ok(registry.byName.has("edit_file"));
  // list_dir is the designated casualty: registered last on purpose.
  assert.ok(registry.all.length <= 16);
});
