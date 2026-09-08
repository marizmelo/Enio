import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-dym-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");

const ws = process.env.ENIO_WORKSPACE!;
mkdirSync(join(ws, "notes"), { recursive: true });
writeFileSync(join(ws, "coffee-brewing.md"), "beans\n");
writeFileSync(join(ws, "notes", "plan.md"), "steps\n");

const { fsTools } = await import("./tools/fs.js");
const readFile = fsTools.find((t) => t.name === "read_file")!;

after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * The coder's largest measured failure: five of six `read_file` calls in the
 * traces errored, every one a guessed path — and two named a file that DID
 * exist one folder away (`library/coffee-brewing.md` for the file at the
 * root). A bare ENOENT ends the turn there; the basename is nearly always
 * right, so the miss should say where that name actually lives.
 */
describe("read_file on a path that is not there", () => {
  test("names the real location when the filename exists elsewhere", async () => {
    const out = String(await readFile.run({ path: "library/coffee-brewing.md" }));
    assert.match(out, /^Error: no file at/);
    assert.match(out, /Did you mean "coffee-brewing\.md"\?/);
  });

  test("finds it inside a subfolder too", async () => {
    const out = String(await readFile.run({ path: "plan.md" }));
    assert.match(out, /Did you mean "notes\/plan\.md"\?/);
  });

  test("stays silent when nothing matches, rather than guessing", async () => {
    // A fuzzy match over whole paths would invent a second wrong answer.
    // This is either exactly right or says nothing.
    const out = String(await readFile.run({ path: "nowhere/absent.md" }));
    assert.match(out, /^Error: no file at/);
    assert.ok(!/Did you mean/.test(out), out);
  });

  test("a file that is there still reads normally", async () => {
    const out = String(await readFile.run({ path: "coffee-brewing.md" }));
    assert.match(out, /beans/);
    assert.ok(!/Did you mean/.test(out));
  });

  test("matching is on the basename, and case-insensitive", async () => {
    const out = String(await readFile.run({ path: "deep/COFFEE-BREWING.MD" }));
    assert.match(out, /Did you mean "coffee-brewing\.md"\?/);
  });
});

/**
 * Reading a folder.
 *
 * The coder does not hold `list_dir` -- `edit_file` took that slot under the
 * six-tool ceiling, and nothing else was droppable. So the instinct the model
 * already has (read the thing) is made to work, which costs nothing against
 * the ceiling and needs no prompt line about a tool it cannot see. EISDIR
 * taught it nothing and ended the turn.
 */
describe("read_file on a tabular file", () => {
  // The observed failure on a small model: hundreds of CSV rows returned
  // whole, half of them beyond what it could still attend to, and answers
  // fabricated about rows it "read". A big table is a preview plus the move
  // that actually analyzes; a small one still reads whole.
  test("a large csv is a preview with honest counts and the python pointer", async () => {
    const rows = ["name,amount", ...Array.from({ length: 200 }, (_, i) => `item${i},${i}`)];
    writeFileSync(join(ws, "sales.csv"), rows.join("\n") + "\n");
    const out = String(await readFile.run({ path: "sales.csv" }));
    assert.match(out, /name,amount/);
    assert.match(out, /20 of 200 data rows/);
    assert.match(out, /Do not answer questions about the full data/);
    assert.match(out, /python3 -c/);
    assert.ok(!out.includes("item150"), "rows past the preview must be absent, not summarized");
  });

  test("a small csv reads whole — nothing to warn about", async () => {
    writeFileSync(join(ws, "tiny.csv"), "a,b\n1,2\n3,4\n");
    const out = String(await readFile.run({ path: "tiny.csv" }));
    assert.match(out, /3,4/);
    assert.ok(!out.includes("preview"), "a table that fits is just read");
  });

  test("a large non-tabular file keeps the plain truncation", async () => {
    writeFileSync(join(ws, "log.txt"), Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n"));
    const out = String(await readFile.run({ path: "log.txt" }));
    assert.match(out, /\[truncated: 100 more lines\]/);
    assert.ok(!out.includes("python3"), "prose is not told to import csv");
  });
});

describe("read_file on a folder", () => {
  test("lists the folder instead of failing", async () => {
    const out = String(await readFile.run({ path: "notes" }));
    assert.match(out, /plan\.md/);
    assert.ok(!/Error/.test(out), out);
  });

  test("marks subfolders so a path can be composed from the listing", async () => {
    const out = String(await readFile.run({ path: "." }));
    assert.match(out, /notes\//, "a directory ends in a slash");
    assert.match(out, /coffee-brewing\.md \(\d+ bytes\)/);
  });

  test("an empty folder says so rather than printing nothing", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(ws, "hollow"), { recursive: true });
    const out = String(await readFile.run({ path: "hollow" }));
    assert.match(out, /is empty/);
  });
});
