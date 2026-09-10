import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-coverage-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");

const { coverageBlock } = await import("./memory/coverage.js");
const { applyTriples } = await import("./memory/store.js");
const { closeDb } = await import("./memory/db.js");

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

const triple = (subject: string, st: string, relation: string, object: string, ot: string) =>
  ({ subject, subject_type: st, relation, object, object_type: ot }) as any;

describe("the coverage map", () => {
  test("an empty graph is no block at all — nothing to claim coverage of", () => {
    assert.equal(coverageBlock(600), "");
  });

  test("names are grouped by type, most connected first, with the not-listed rule", () => {
    applyTriples(
      [
        triple("Sam", "person", "WORKS_ON", "enio", "project"),
        triple("Sam", "person", "USES", "Ghostty", "technology"),
        triple("Alice", "person", "KNOWS", "Sam", "person"),
        triple("enio", "project", "USES", "Ghostty", "technology"),
      ],
      "s1",
    );
    const block = coverageBlock(600);
    assert.match(block, /^Memory has something on — /);
    assert.match(block, /people: Sam, Alice/, "Sam has more edges than Alice and comes first");
    assert.match(block, /projects: enio/);
    assert.match(block, /technologies: Ghostty/);
    assert.match(block, /you do not remember: say so rather than guess/);
  });

  test("a crowded type cannot push the others off the end, and the tail counts what was cut", () => {
    applyTriples(
      Array.from({ length: 30 }, (_, i) =>
        triple("Sam", "person", "LEARNING", `concept number ${i}`, "concept"),
      ),
      "s2",
    );
    // Tight enough that thirty concepts cannot all fit.
    const block = coverageBlock(260);
    assert.match(block, /people: Sam/, "people survive a flood of concepts");
    assert.match(block, /projects: enio/);
    assert.match(block, /concepts: [^·]*\(\+\d+\)/, "the cut is counted, not hidden");
    assert.ok(block.length <= 260, `block must honor its budget, got ${block.length}`);
  });

  test("too small a budget yields nothing rather than a truncated lie", () => {
    assert.equal(coverageBlock(30), "");
  });
});
