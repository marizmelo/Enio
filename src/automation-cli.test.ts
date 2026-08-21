import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-autocli-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

const { savePipeline, listPipelines, deletePipeline } = await import("./pipelines.js");
const { addTask, listTasks, removeTask } = await import("./tasks.js");
const { ABILITIES } = await import("./abilities.js");
const { closeDb } = await import("./memory/db.js");

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Automations from the CLI.
 *
 * Retiring the task commands took scheduling out of the CLI with them, which
 * is wrong for a tool that runs headless. What has to hold: a CLI-built
 * automation is the same row the app builds, and its schedule is the same
 * reserved task name the panel reads — otherwise the two surfaces would each
 * have their own idea of what is scheduled.
 */
describe("an automation built from the CLI", () => {
  test("is one step, and the agent decides the ability it runs as", () => {
    // "--agent coder" has to become an ability whose specialist is the coder;
    // the bare `@coder ___` template is the general-purpose one, not a narrow
    // tile like "Search my project" that would quietly scope the step.
    const coder = ABILITIES.filter((a) => a.specialist === "coder");
    const bare = coder.find((a) => /^@coder ___$/.test(a.promptTemplate));
    assert.ok(bare, "the coder has a general-purpose ability");
    const p = savePipeline({
      name: "brief",
      nodes: [{ id: "n1", abilityId: bare!.id, prompt: "Summarise my open work" }],
      edges: [],
    });
    assert.equal(p.nodes.length, 1);
    assert.equal(p.nodes[0]!.abilityId, bare!.id);
  });

  test("its schedule is the reserved name the panel reads, so both agree", () => {
    const p = listPipelines().find((x) => x.name === "brief")!;
    addTask({ name: `auto-${p.id}`, pipeline: p.name, schedule: "0 9 * * 1" });
    const task = listTasks().find((t) => t.name === `auto-${p.id}`);
    assert.ok(task, "the schedule is findable by the id-derived name");
    assert.equal(task!.pipeline, "brief", "and points at the pipeline by NAME");
  });

  test("removing the automation takes its schedule with it", () => {
    const p = listPipelines().find((x) => x.name === "brief")!;
    deletePipeline(p.id);
    assert.equal(listTasks().find((t) => t.name === `auto-${p.id}`), undefined);
  });

  test("unscheduling leaves the automation alone", () => {
    const p = savePipeline({
      name: "keeper",
      nodes: [{ id: "n1", abilityId: "prompt", prompt: "hello" }],
      edges: [],
    });
    addTask({ name: `auto-${p.id}`, pipeline: p.name, schedule: "0 9 * * 1" });
    removeTask(`auto-${p.id}`);
    assert.ok(listPipelines().some((x) => x.name === "keeper"), "the flow survives");
    assert.equal(listTasks().find((t) => t.name === `auto-${p.id}`), undefined);
  });
});
