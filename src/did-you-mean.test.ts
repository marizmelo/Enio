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
