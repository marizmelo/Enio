import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const scratch = mkdtempSync(join(tmpdir(), "enio-fastroute-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");

const fast = await import("./routing-fast.js");
const { SPECIALISTS } = await import("./specialists.js");
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

  test("the held-out benchmark is held out: no prompt is an example or a description", async () => {
    const { BENCH } = (await import(pathToFileURL(join(process.cwd(), "scripts", "route-bench-data.mjs")).href)) as {
      BENCH: Array<[string, string]>;
    };
    const known = new Set(fast.routingExemplars(SPECIALISTS).map((e) => e.text.trim().toLowerCase()));
    for (const [prompt, want] of BENCH) {
      assert.ok(!known.has(prompt.trim().toLowerCase()), `benchmark prompt is a routing example: ${prompt}`);
      assert.ok(SPECIALISTS.some((s) => s.name === want), `unknown label ${want}`);
    }
    assert.ok(BENCH.length >= 40);
    for (const s of SPECIALISTS) {
      assert.ok(BENCH.filter(([, w]) => w === s.name).length >= 6, `${s.name} needs six benchmark prompts`);
    }
  });
});
