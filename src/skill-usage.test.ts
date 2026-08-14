import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-skill-usage-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_MCP_CONFIG = join(scratch, "none.json");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");

const { skillUsage } = await import("./skill-usage.js");
const { loadSkills, skillsDir } = await import("./skills.js");
const { getDb, closeDb } = await import("./memory/db.js");
const tasksRoutes = await import("./routes/tasks-routes.js");
const skillsRoutes = await import("./routes/skills-routes.js");
const pipelines = await import("./pipelines.js");
const tasks = await import("./tasks.js");

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

function installSkill(name: string, description = `does ${name}`): void {
  const dir = join(skillsDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);
}

/** Inserts one turn and returns its id. */
function turn(startedAt: number): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO turns (session_id, question, started_at) VALUES ('s1', 'q', ?)`,
      )
      .run(startedAt).lastInsertRowid,
  );
}

function step(turnId: number, kind: string, name: string, args: string, output: string): void {
  getDb()
    .prepare(
      `INSERT INTO turn_steps (turn_id, seq, kind, name, args, output) VALUES (?, 0, ?, ?, ?, ?)`,
    )
    .run(turnId, kind, name, args, output);
}

describe("skillUsage", () => {
  test("counts distinct turns, not read_skill rows", () => {
    installSkill("commit-message");
    const t1 = turn(1_000);
    // One turn, three read_skill calls (body + two reference files): one use.
    step(t1, "tool", "read_skill", `{"name":"commit-message"}`, "# Skill: commit-message");
    step(t1, "tool", "read_skill", `{"name":"commit-message","file":"a.md"}`, "ref a");
    step(t1, "tool", "read_skill", `{"name":"commit-message","file":"b.md"}`, "ref b");
    const t2 = turn(2_000);
    step(t2, "tool", "read_skill", `{"name":"commit-message"}`, "# Skill: commit-message");

    const { usage } = skillUsage(loadSkills());
    assert.equal(usage["commit-message"]?.uses, 2);
    assert.equal(usage["commit-message"]?.lastUsedAt, 2_000);
  });

  test("resolves paraphrased names through findSkill's prefix rule", () => {
    installSkill("weekly-report-writer");
    const t = turn(3_000);
    step(t, "tool", "read_skill", `{"name":"weekly-report"}`, "# Skill: weekly-report-writer");
    const { usage } = skillUsage(loadSkills());
    assert.equal(usage["weekly-report-writer"]?.uses, 1, "prefix ask attributes to the real skill");
  });

  test("misses go to unresolved, never to a skill", () => {
    const t = turn(4_000);
    step(t, "tool", "read_skill", `{"name":"no-such-skill"}`, `No skill named "no-such-skill". Available: none installed`);
    step(t, "tool", "read_skill", `{"name":"no-such-skill"}`, `No skill named "no-such-skill". Available: none installed`);
    const { usage, unresolved } = skillUsage(loadSkills());
    assert.equal(usage["no-such-skill"], undefined);
    const miss = unresolved.find((u) => u.name === "no-such-skill");
    assert.ok(miss, "the ask itself is a finding");
    assert.equal(miss!.count, 2);
    assert.equal(miss!.lastAt, 4_000);
  });

  test("harness skill_invoked rows count as uses", () => {
    installSkill("invoked-directly");
    const t = turn(5_000);
    step(t, "harness", "skill_invoked", `{"names":["invoked-directly"]}`, "");
    const { usage } = skillUsage(loadSkills());
    assert.equal(usage["invoked-directly"]?.uses, 1);
    assert.equal(usage["invoked-directly"]?.lastUsedAt, 5_000);
  });

  test("the same turn reading and being handed a skill is one use", () => {
    installSkill("double-counted");
    const t = turn(6_000);
    step(t, "tool", "read_skill", `{"name":"double-counted"}`, "# Skill: double-counted");
    step(t, "harness", "skill_invoked", `{"names":["double-counted"]}`, "");
    const { usage } = skillUsage(loadSkills());
    assert.equal(usage["double-counted"]?.uses, 1);
  });
});

/* ------------------------------------------------------- route harnesses */

function stubReq(method: string, body?: string): never {
  const req = new EventEmitter() as EventEmitter & { method: string };
  req.method = method;
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit("data", body);
      req.emit("end");
    });
  }
  return req as never;
}

function stubRes(): { res: never; sent: () => { status: number; body: any } } {
  let status = 0;
  let raw = "";
  const res = {
    writeHead(s: number) {
      status = s;
      return res;
    },
    end(chunk: string) {
      raw = chunk;
    },
  };
  return { res: res as never, sent: () => ({ status, body: JSON.parse(raw) }) };
}

const urlFor = (path: string) => new URL(`http://localhost${path}`);

describe("tasks routes", () => {
  test("scheduling an unvouched automation is refused with 409", async () => {
    const p = pipelines.savePipeline({
      name: "route-flow",
      nodes: [{ id: "n1", abilityId: "prompt", prompt: "say hi" }],
      edges: [],
    });
    const { res, sent } = stubRes();
    await tasksRoutes.handle(
      stubReq("POST", JSON.stringify({ pipelineId: p.id, cron: "0 9 * * *" })),
      res,
      urlFor("/tasks/schedule"),
    );
    assert.equal(sent().status, 409);
    assert.match(sent().body.error.message, /Run it successfully once first/);
  });

  test("schedule upsert keeps the task id; clearing removes it", async () => {
    const p = pipelines.savePipeline({
      name: "vouched-flow",
      nodes: [{ id: "n1", abilityId: "prompt", prompt: "say hi" }],
      edges: [],
    });
    getDb()
      .prepare(
        `INSERT INTO pipeline_runs (id, pipeline_id, started_at, finished_at, status) VALUES ('vr', ?, 1, 2, 'succeeded')`,
      )
      .run(p.id);

    let { res, sent } = stubRes();
    await tasksRoutes.handle(
      stubReq("POST", JSON.stringify({ pipelineId: p.id, cron: "0 9 * * *" })),
      res,
      urlFor("/tasks/schedule"),
    );
    assert.equal(sent().status, 200);
    const firstId = sent().body.task.id;

    ({ res, sent } = stubRes());
    await tasksRoutes.handle(
      stubReq("POST", JSON.stringify({ pipelineId: p.id, cron: "0 8 * * *" })),
      res,
      urlFor("/tasks/schedule"),
    );
    assert.equal(sent().body.task.id, firstId, "an edit must not orphan run history");
    assert.equal(sent().body.task.schedule, "0 8 * * *");

    ({ res, sent } = stubRes());
    await tasksRoutes.handle(stubReq("GET"), res, urlFor("/tasks"));
    const listed = sent().body.tasks.find((t: { name: string }) => t.name === `auto-${p.id}`);
    assert.ok(listed);
    assert.equal(listed.isAutoSchedule, true);
    assert.ok(listed.nextRun, "an enabled schedule reports when it fires next");

    ({ res, sent } = stubRes());
    await tasksRoutes.handle(stubReq("DELETE"), res, urlFor(`/tasks/schedule/${p.id}`));
    assert.equal(sent().body.removed, true);
    assert.equal(tasks.getTask(`auto-${p.id}`), null);
  });

  test("a user's own auto- prefixed task is not claimed as a schedule chip", async () => {
    tasks.addTask({ name: "auto-daily", prompt: "do the daily thing", schedule: "0 7 * * *" });
    const { res, sent } = stubRes();
    await tasksRoutes.handle(stubReq("GET"), res, urlFor("/tasks"));
    const mine = sent().body.tasks.find((t: { name: string }) => t.name === "auto-daily");
    assert.equal(mine.isAutoSchedule, false);
    tasks.removeTask("auto-daily");
  });

  test("scheduling an unknown automation is 404", async () => {
    const { res, sent } = stubRes();
    await tasksRoutes.handle(
      stubReq("POST", JSON.stringify({ pipelineId: "nope", cron: "0 9 * * *" })),
      res,
      urlFor("/tasks/schedule"),
    );
    assert.equal(sent().status, 404);
  });
});

describe("skills route", () => {
  test("lists skills with usage, and broken ones with their reason", async () => {
    installSkill("healthy-skill");
    const broken = join(skillsDir(), "broken-skill");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "SKILL.md"), "no frontmatter at all");

    const { res, sent } = stubRes();
    await skillsRoutes.handle(stubReq("GET"), res, urlFor("/skills"));
    const { skills, unresolved } = sent().body;

    const healthy = skills.find((s: { name: string }) => s.name === "healthy-skill");
    assert.ok(healthy);
    assert.equal(healthy.broken, false);
    assert.equal(healthy.source, "global");
    assert.deepEqual(healthy.usage, { uses: 0, lastUsedAt: null });

    const bad = skills.find((s: { name: string }) => s.name === "broken-skill");
    assert.ok(bad, "a broken skill is a row, not a hidden log line");
    assert.equal(bad.broken, true);
    assert.match(bad.reason, /frontmatter/);

    assert.ok(Array.isArray(unresolved));
  });
});
