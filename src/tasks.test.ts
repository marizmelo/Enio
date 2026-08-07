import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-tasks-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_MCP_CONFIG = join(scratch, "none.json");

const tasks = await import("./tasks.js");
const suggest = await import("./suggest.js");
const { closeDb } = await import("./memory/db.js");

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

describe("task definition", () => {
  test("adds and reads back", () => {
    const t = tasks.addTask({
      name: "weekly-review",
      prompt: "Summarise what I worked on this week",
      schedule: "0 9 * * 1",
    });
    assert.equal(t.name, "weekly-review");
    assert.equal(t.enabled, true);
    assert.equal(tasks.getTask("weekly-review")?.prompt, "Summarise what I worked on this week");
  });

  test("rejects a bad cron at creation, not at 3am", () => {
    assert.throws(
      () => tasks.addTask({ name: "bad", prompt: "x", schedule: "not a cron" }),
      /invalid schedule/,
    );
  });

  test("rejects an empty prompt", () => {
    assert.throws(
      () => tasks.addTask({ name: "empty", prompt: "   ", schedule: "0 9 * * 1" }),
      /needs a prompt/,
    );
  });

  test("rejects an unusable name", () => {
    assert.throws(
      () => tasks.addTask({ name: "Has Spaces", prompt: "x", schedule: "0 9 * * 1" }),
      /invalid name/,
    );
  });

  test("enable and disable", () => {
    assert.equal(tasks.setTaskEnabled("weekly-review", false), true);
    assert.equal(tasks.getTask("weekly-review")?.enabled, false);
    tasks.setTaskEnabled("weekly-review", true);
  });

  test("removing one that doesn't exist is not an error", () => {
    assert.equal(tasks.removeTask("never-existed"), false);
  });
});

describe("schedule validation", () => {
  test("accepts standard expressions and reports the next run", () => {
    for (const cron of ["0 9 * * 1", "*/15 * * * *", "0 0 1 * *"]) {
      const result = tasks.validateSchedule(cron);
      assert.equal(result.ok, true, `${cron} should be valid`);
      if (result.ok) assert.ok(result.next.getTime() > Date.now());
    }
  });

  test("rejects nonsense", () => {
    for (const cron of ["hello", "99 99 99 99 99", ""]) {
      assert.equal(tasks.validateSchedule(cron).ok, false, `${cron} should be rejected`);
    }
  });
});

describe("clustering", () => {
  const sim = (a: string, b: string) => suggest.lexicalSimilarity(a, b);

  test("groups reworded versions of the same request", () => {
    const questions = [
      "summarise what I worked on this week",
      "summarize my work from this week please",
      "give me a summary of this week's work",
      "what is the capital of France",
    ];
    const clusters = suggest.clusterBy(questions, sim, 0.3, 2);
    assert.equal(clusters.length, 1, "the unrelated question must not join");
    assert.equal(clusters[0]!.members.length, 3);
  });

  test("respects the minimum size", () => {
    const questions = ["deploy the staging build", "deploy staging build now"];
    assert.equal(suggest.clusterBy(questions, sim, 0.3, 3).length, 0);
    assert.equal(suggest.clusterBy(questions, sim, 0.3, 2).length, 1);
  });

  test("returns the largest cluster first", () => {
    const items = ["alpha beta gamma", "alpha beta gamma delta", "alpha beta gamma epsilon",
                   "zulu yankee xray", "zulu yankee xray whiskey"];
    const clusters = suggest.clusterBy(items, sim, 0.3, 2);
    assert.ok(clusters[0]!.members.length >= clusters.at(-1)!.members.length);
  });

  test("ignores stopwords so phrasing doesn't create false matches", () => {
    // These share only filler words and must not be treated as similar.
    const score = suggest.lexicalSimilarity(
      "please could you show me the thing",
      "please could you tell me about that",
    );
    assert.ok(score < 0.3, `too similar: ${score}`);
  });
});

describe("stemming", () => {
  test("collapses tense and spelling variants", () => {
    // These are the rephrasings people actually produce when repeating a
    // request, and the whole lexical fallback depends on catching them.
    assert.equal(suggest.stem("worked"), suggest.stem("work"));
    assert.equal(suggest.stem("summarise"), suggest.stem("summarize"));
    assert.equal(suggest.stem("summarize"), suggest.stem("summary"));
    assert.equal(suggest.stem("deploying"), suggest.stem("deployed"));
  });

  test("does not over-stem short words into collisions", () => {
    assert.notEqual(suggest.stem("week"), suggest.stem("work"));
    assert.notEqual(suggest.stem("test"), suggest.stem("text"));
    // Stripping must never leave a stub too short to be meaningful.
    assert.ok(suggest.stem("thing").length >= 3);
  });
});

describe("time patterns", () => {
  /** Timestamps on a given weekday and hour, across consecutive weeks. */
  const weekly = (day: number, hour: number, count: number) => {
    const out: number[] = [];
    const base = new Date(2026, 0, 5, hour, 0, 0); // a Monday
    base.setDate(base.getDate() + ((day - base.getDay() + 7) % 7));
    for (let i = 0; i < count; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i * 7);
      out.push(d.getTime());
    }
    return out;
  };

  test("spots a weekly pattern and emits a matching cron", () => {
    const pattern = suggest.detectTimePattern(weekly(1, 9, 5));
    assert.ok(pattern, "should detect Monday mornings");
    assert.match(pattern!.description, /Monday/);
    assert.equal(pattern!.cron, "0 9 * * 1");
  });

  test("needs more than a couple of samples", () => {
    assert.equal(suggest.detectTimePattern(weekly(1, 9, 2)), null);
  });

  test("returns nothing for scattered times", () => {
    // Proposing a schedule from noise is worse than proposing nothing.
    const scattered = [
      new Date(2026, 0, 5, 9).getTime(),
      new Date(2026, 0, 6, 14).getTime(),
      new Date(2026, 0, 8, 22).getTime(),
      new Date(2026, 0, 11, 3).getTime(),
      new Date(2026, 0, 14, 17).getTime(),
    ];
    assert.equal(suggest.detectTimePattern(scattered), null);
  });

  test("spots a daily hour when the weekday varies", () => {
    const dailyAt8 = [0, 1, 2, 3, 4].map((d) => new Date(2026, 0, 5 + d, 8).getTime());
    const pattern = suggest.detectTimePattern(dailyAt8);
    assert.ok(pattern);
    assert.equal(pattern!.cron, "0 8 * * *");
  });
});

describe("naming and drafting", () => {
  test("slugs a question into a usable skill name", () => {
    const name = suggest.slug("Please summarise what I worked on this week");
    assert.match(name, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(!name.includes("please"), "stopwords should be dropped");
  });

  test("never produces an empty name", () => {
    assert.equal(suggest.slug("what is that?"), "untitled");
  });

  test("drafts a valid SKILL.md", async () => {
    const draft = suggest.draftSkill({
      kind: "skill",
      title: "Summarise the week",
      reason: "Asked 5 times in different words.",
      evidence: ["summarise my week", "what did I do this week"],
      suggestedName: "summarise-week",
      tools: ["recall", "run_command"],
    });
    // The draft must actually load as a skill, or the suggestion is useless.
    const { parseSkill } = await import("./skills.js");
    const parsed = parseSkill(draft, "/tmp/x", "fallback");
    assert.equal(parsed.name, "summarise-week");
    assert.deepEqual(parsed.allowedTools, ["recall", "run_command"]);
    assert.match(parsed.body, /Replace everything below/);
  });

  test("shorten preserves short text and marks truncation", () => {
    assert.equal(suggest.shorten("short"), "short");
    assert.match(suggest.shorten("x".repeat(200)), /…$/);
  });
});
