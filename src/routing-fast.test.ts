import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const scratch = mkdtempSync(join(tmpdir(), "enio-fastroute-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
// The environment outranks the recorded switch, so a shell that exports it
// would decide the calendar tests below instead of the fixture.
delete process.env.ENIO_DESKTOP;
delete process.env.MAPLE_DESKTOP;

const fast = await import("./routing-fast.js");
const { SPECIALISTS } = await import("./specialists.js");
const accounts = await import("./accounts.js");
const { setDesktopControl } = await import("./automation.js");
const { detectPlatform } = await import("./platform.js");
const { closeDb } = await import("./memory/db.js");
after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

const vec = (...xs: number[]) => {
  const n = Math.hypot(...xs);
  return Float32Array.from(xs.map((x) => x / n));
};

describe("the fast routing tier", () => {
  test("a decision is the best specialist with its gap to the runner-up as confidence", () => {
    const ex = [
      { text: "a", specialist: "coder", vector: vec(1, 0, 0) },
      { text: "b", specialist: "coder", vector: vec(0.9, 0.1, 0) },
      { text: "c", specialist: "mail", vector: vec(0, 1, 0) },
      { text: "d", specialist: "operator", vector: vec(0, 0, 1) },
    ];
    const d = fast.decide(vec(0.95, 0.3, 0), ex)!;
    assert.equal(d.specialist, "coder");
    assert.equal(d.runnerUp, "mail");
    assert.ok(d.margin > 0.5, `wide margin: ${d.margin}`);
    // Each specialist is represented by its BEST example, not its average:
    // a second, weaker coder example must not dilute the coder.
    const diluted = fast.decide(vec(0.95, 0.3, 0), [...ex, { text: "e", specialist: "coder", vector: vec(0, 0, 1) }])!;
    assert.equal(diluted.specialist, "coder");
    assert.equal(diluted.margin, d.margin);
  });

  test("a request between two specialists has a thin margin — that is what sends it to the model", () => {
    const ex = [
      { text: "a", specialist: "coder", vector: vec(1, 0) },
      { text: "c", specialist: "mail", vector: vec(0, 1) },
    ];
    const d = fast.decide(vec(1, 1), ex)!;
    assert.ok(Math.abs(d.margin) < 1e-6, `margin ${d.margin}`);
    assert.equal(fast.decide(vec(1, 0), []), null, "no exemplars, no decision");
  });

  test("every built-in specialist has at least one example, and the exemplars name only live specialists", () => {
    const ex = fast.routingExemplars(SPECIALISTS);
    for (const s of SPECIALISTS) {
      // The planner and mail are covered by their descriptions when the
      // example list is thin; the description counts as an exemplar.
      assert.ok(ex.some((e) => e.specialist === s.name), `${s.name} has no exemplar`);
    }
    assert.ok(ex.every((e) => SPECIALISTS.some((s) => s.name === e.specialist)));
    assert.ok(fast.ROUTING_EXAMPLES.length >= 15);
  });

  test("the benchmarks are held out: no prompt is an example or a description", async () => {
    const { BENCH, BOUNDARY } = (await import(pathToFileURL(join(process.cwd(), "scripts", "route-bench-data.mjs")).href)) as {
      BENCH: Array<[string, string]>;
      BOUNDARY: Array<[string, string]>;
    };
    const known = new Set(fast.routingExemplars(SPECIALISTS).map((e) => e.text.trim().toLowerCase()));
    for (const [prompt, want] of [...BENCH, ...BOUNDARY]) {
      assert.ok(!known.has(prompt.trim().toLowerCase()), `benchmark prompt is a routing example: ${prompt}`);
      assert.ok(SPECIALISTS.some((s) => s.name === want), `unknown label ${want}`);
    }
    assert.ok(BENCH.length >= 40);
    for (const s of SPECIALISTS) {
      assert.ok(BENCH.filter(([, w]) => w === s.name).length >= 6, `${s.name} needs six benchmark prompts`);
    }
    const seen = new Set<string>();
    for (const [prompt] of [...BENCH, ...BOUNDARY]) {
      assert.ok(!seen.has(prompt), `the same prompt is benchmarked twice: ${prompt}`);
      seen.add(prompt);
    }
  });
});

/**
 * The planner went without a single example in the router's prompt from the
 * day it was added, covered in the test above by its description — and the
 * model routes by the examples, so nearly every calendar or todo change it
 * decided went to the operator. Nothing failed; the wrong agent answered.
 */
describe("the router's examples follow who can act", () => {
  const withWriteGrant = (on: boolean) => {
    mkdirSync(process.env.ENIO_DATA_DIR!, { recursive: true });
    writeFileSync(
      accounts.accountsFile(),
      JSON.stringify({
        client: null,
        accounts: on
          ? [{ id: "a1", provider: "appsscript", email: "me@example.com", grants: ["calendar.read", "calendar.write"], addedAt: 1, scriptUrl: "https://script.example/exec", scriptSecret: "s" }]
          : [],
      }),
    );
  };
  const promptOwners = () => new Set(fast.resolveExamples(fast.ROUTING_EXAMPLES).map((e) => e.specialist));
  const ownerOfText = (text: string) =>
    fast.resolveExamples([...fast.ROUTING_EXAMPLES, ...fast.FAST_EXEMPLARS]).find((e) => e.text === text)!.specialist;
  const onMac = detectPlatform().startsWith("macos");

  test("a calendar change goes to the planner when it holds the tool, else to the operator when that one does", () => {
    withWriteGrant(true);
    setDesktopControl(true);
    assert.equal(fast.calendarChanger(), "planner", "the planner's one tool call beats a plan in the Calendar app");
    assert.equal(ownerOfText("add lunch to my calendar for noon"), "planner");

    withWriteGrant(false);
    // Desktop control exists only on macOS; elsewhere the operator holds no
    // plan tool either, and the planner's connect-an-account notice is the
    // useful dead end.
    assert.equal(fast.calendarChanger(), onMac ? "operator" : "planner");
    assert.equal(ownerOfText("add lunch to my calendar for noon"), onMac ? "operator" : "planner");
    assert.equal(ownerOfText("mark the report todo as done"), onMac ? "operator" : "planner");
    // Reading is not a change: it stays the planner's on every install.
    assert.equal(ownerOfText("what's on my calendar today"), "planner");
    assert.equal(ownerOfText("when is my next meeting"), "planner");

    setDesktopControl(false);
    assert.equal(fast.calendarChanger(), "planner", "with neither tool, the planner says how to connect an account");
  });

  test("every built-in specialist has an example in the model router's prompt, on every install", () => {
    for (const [grant, desktop] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      withWriteGrant(grant);
      setDesktopControl(desktop);
      const owners = promptOwners();
      for (const s of SPECIALISTS) {
        assert.ok(owners.has(s.name), `${s.name} has no prompt example (write grant ${grant}, desktop ${desktop})`);
      }
    }
    setDesktopControl(false);
    withWriteGrant(false);
  });

  test("an example is stated once: the two tables share no text", () => {
    const texts = [...fast.ROUTING_EXAMPLES, ...fast.FAST_EXEMPLARS].map((e) => e.text.trim().toLowerCase());
    assert.equal(new Set(texts).size, texts.length);
  });
});
