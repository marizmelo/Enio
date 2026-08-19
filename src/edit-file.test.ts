import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * edit_file: exact old→new replacement that must match exactly once.
 *
 * The tool exists because write_file is whole-file overwrite, and a 4B model
 * asked to fix one line of a 300-line file regenerates all 300 and drifts.
 * The cases that matter are the ones that fail quietly: a passage copied out
 * of read_file's numbered output (gutter included), a passage that matches
 * twice, and a write that would have taken the workspace read-fallback.
 */
const scratch = mkdtempSync(join(tmpdir(), "enio-edit-"));
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-such-mcp.json");
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

const { fsTools } = await import("./tools/fs.js");
const project = await import("./project.js");
const editFile = fsTools.find((t) => t.name === "edit_file")!;
const readFile = fsTools.find((t) => t.name === "read_file")!;
const run = (args: Record<string, unknown>) => editFile.run(args) as Promise<string>;
const ws = (rel: string) => join(process.env.ENIO_WORKSPACE!, rel);

after(() => rmSync(scratch, { recursive: true, force: true }));

test("replaces an exact single match and speaks write_file's dialect", async () => {
  writeFileSync(ws("greet.ts"), 'export const greet = (n: string) => "helo " + n;\n');
  const out = await run({ path: "greet.ts", old_string: '"helo "', new_string: '"hello "' });
  assert.match(out, /^Wrote \d+ bytes to greet\.ts$/m, "first line is the artifact grammar");
  assert.match(out, /Replaced 1 passage at line 1/);
  assert.equal(readFileSync(ws("greet.ts"), "utf8"), 'export const greet = (n: string) => "hello " + n;\n');
});

test("zero matches is an error naming the file, and the file is untouched", async () => {
  writeFileSync(ws("a.ts"), "const a = 1;\n");
  await assert.rejects(
    run({ path: "a.ts", old_string: "const b = 1;", new_string: "const b = 2;" }),
    /old_string was not found in a\.ts.*without line numbers/,
  );
  assert.equal(readFileSync(ws("a.ts"), "utf8"), "const a = 1;\n");
});

test("more than one match is refused with the count", async () => {
  writeFileSync(ws("dup.ts"), "x = 1;\nx = 1;\n");
  await assert.rejects(
    run({ path: "dup.ts", old_string: "x = 1;", new_string: "x = 2;" }),
    /matches 2 times in dup\.ts; include more surrounding lines/,
  );
  assert.equal(readFileSync(ws("dup.ts"), "utf8"), "x = 1;\nx = 1;\n");
});

test("a passage copied out of read_file's numbered output still matches", async () => {
  writeFileSync(ws("num.ts"), "function f() {\n  return 1;\n}\n");
  // What the model actually sees: the gutter.
  const shown = (await readFile.run({ path: "num.ts" })) as string;
  const gutterLines = shown.split("\n").slice(0, 2).join("\n"); // "   1 | function f() {\n   2 |   return 1;"
  assert.match(gutterLines, /^\s*1 \| function f\(\) \{\n\s*2 \|   return 1;$/);
  const out = await run({
    path: "num.ts",
    old_string: gutterLines,
    new_string: "   1 | function f() {\n   2 |   return 2;",
  });
  assert.match(out, /Replaced 1 passage/);
  assert.equal(readFileSync(ws("num.ts"), "utf8"), "function f() {\n  return 2;\n}\n");
});

test("content that literally contains a gutter-shaped line is never stripped", async () => {
  // A file that happens to hold "   1 | x" as text: the literal match wins,
  // and no stripping happens because the literal was found.
  writeFileSync(ws("lit.txt"), "   1 | x\nother\n");
  const out = await run({ path: "lit.txt", old_string: "   1 | x", new_string: "   1 | y" });
  assert.match(out, /Replaced 1 passage/);
  assert.equal(readFileSync(ws("lit.txt"), "utf8"), "   1 | y\nother\n");
});

test("a passage where only SOME lines carry a gutter is not stripped (it is not a copy)", async () => {
  writeFileSync(ws("mixed.ts"), "a\nb\n");
  await assert.rejects(
    run({ path: "mixed.ts", old_string: "   1 | a\nb", new_string: "z" }),
    /old_string was not found/,
  );
});

test("a missing file points at write_file; a binary file is refused", async () => {
  await assert.rejects(
    run({ path: "nope.ts", old_string: "a", new_string: "b" }),
    /No file at nope\.ts\. Use write_file/,
  );
  writeFileSync(ws("blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
  await assert.rejects(run({ path: "blob.bin", old_string: "a", new_string: "b" }), /is binary/);
});

test("an empty old_string is refused", async () => {
  writeFileSync(ws("e.ts"), "x\n");
  await assert.rejects(run({ path: "e.ts", old_string: "", new_string: "y" }), /old_string is empty/);
});

test("escapes are refused", async () => {
  await assert.rejects(run({ path: "../outside.ts", old_string: "a", new_string: "b" }), /escapes/);
});

test("with a project open, an unprefixed name that exists only in the workspace is NOT edited there", async () => {
  // The workspace read-fallback must not become a write path: edit_file on
  // such a name resolves into the project (where it does not exist) and
  // says so, rather than silently editing the conversation's file.
  writeFileSync(ws("stray.md"), "# stray\n");
  const p = project.createProject({ name: "sandbox" });
  project.openProject(p.id);
  try {
    await assert.rejects(
      run({ path: "stray.md", old_string: "stray", new_string: "changed" }),
      /No file at stray\.md/,
    );
    assert.equal(readFileSync(ws("stray.md"), "utf8"), "# stray\n", "workspace file untouched");
    // And an alias path edits inside the mount.
    const api = join(scratch, "api");
    mkdirSync(api, { recursive: true });
    writeFileSync(join(api, "x.ts"), "let v = 1;\n");
    project.attachPath(p.id, api, "the api");
    const out = await run({ path: "api/x.ts", old_string: "let v = 1;", new_string: "let v = 2;" });
    assert.match(out, /Wrote \d+ bytes to api\/x\.ts/);
    assert.equal(readFileSync(join(api, "x.ts"), "utf8"), "let v = 2;\n");
  } finally {
    project.closeProject();
  }
});

test("a code project with one attached folder: plain code paths root there; documents still go to out/", async () => {
  // The user attached a folder to build an app in, the model wrote three
  // correct files with plain paths, and they landed in the hidden out/ dir
  // under ~/.enio -- "files not being created". Attaching the one folder
  // WAS the instruction.
  const { safePath } = await import("./tools/fs.js");
  const repoDir = join(scratch, "onlyrepo");
  mkdirSync(repoDir, { recursive: true });
  const p = project.createProject({ name: "oneapp", type: "code" });
  project.attachPath(p.id, repoDir, "the app");
  project.openProject(p.id);
  try {
    const real = (await import("node:fs")).realpathSync(repoDir);
    assert.equal(safePath("js/app.js", { forWrite: true }), join(real, "js", "app.js"));
    assert.equal(safePath("index.html"), join(real, "index.html"));
    // Documents keep the out/ home: a draft must not litter the repo.
    assert.equal(safePath("notes.md", { forWrite: true }), join(project.activeProject()!.outDir, "notes.md"));
    // And the alias form still works, identically.
    assert.equal(safePath("onlyrepo/js/app.js"), join(real, "js", "app.js"));
  } finally {
    project.closeProject();
  }

  // Two folders: ambiguous, so plain paths go to out/ as before.
  const a = join(scratch, "repoA"); const b = join(scratch, "repoB");
  mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
  const q = project.createProject({ name: "twoapp", type: "code" });
  project.attachPath(q.id, a, "a"); project.attachPath(q.id, b, "b");
  project.openProject(q.id);
  try {
    assert.equal(safePath("js/app.js", { forWrite: true }), join(project.activeProject()!.outDir, "js", "app.js"));
  } finally {
    project.closeProject();
  }

  // A general project with one folder: it is context, not the build target.
  const g = join(scratch, "refs"); mkdirSync(g, { recursive: true });
  const r = project.createProject({ name: "general1", type: "general" });
  project.attachPath(r.id, g, "refs");
  project.openProject(r.id);
  try {
    assert.equal(safePath("draft.js", { forWrite: true }), join(project.activeProject()!.outDir, "draft.js"));
  } finally {
    project.closeProject();
  }
});
