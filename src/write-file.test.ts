import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * write_file keeps what it overwrites. A 3B rewrote a 711-line file to 92
 * lines twice in one afternoon; the warning said the previous contents were
 * "not recoverable from here", and they were not. Now they are.
 */
const scratch = mkdtempSync(join(tmpdir(), "enio-write-"));
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-such-mcp.json");
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

const { fsTools } = await import("./tools/fs.js");
const writeTool = fsTools.find((t) => t.name === "write_file")!;
const run = (args: Record<string, unknown>) => writeTool.run(args) as Promise<string | { text: string; notice?: string }>;
const text = (r: string | { text: string }) => (typeof r === "string" ? r : r.text);
const ws = (rel: string) => join(process.env.ENIO_WORKSPACE!, rel);
const stashDir = join(process.env.ENIO_DATA_DIR!, "stash");

after(() => rmSync(scratch, { recursive: true, force: true }));

test("a new file stashes nothing; an overwrite keeps the previous version and says where", async () => {
  const fresh = text(await run({ path: "notes.md", content: "one\n" }));
  assert.match(fresh, /^Wrote 4 bytes to notes\.md$/);
  assert.ok(!existsSync(stashDir) || readdirSync(stashDir).length === 0);

  const over = text(await run({ path: "notes.md", content: "two\n" }));
  assert.match(over, /previous version kept: stash\//);
  const kept = readdirSync(stashDir);
  assert.equal(kept.length, 1);
  assert.match(kept[0]!, /-notes\.md$/);
  assert.equal(readFileSync(join(stashDir, kept[0]!), "utf8"), "one\n");
  assert.equal(readFileSync(ws("notes.md"), "utf8"), "two\n");
});

test("the big-loss warning points at the kept copy instead of calling it unrecoverable", async () => {
  writeFileSync(ws("app.js"), Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
  const r = (await run({ path: "app.js", content: "short\n" })) as { text: string; notice?: string };
  assert.match(r.text, /100 lines and is now 2/);
  assert.match(r.text, /previous version is kept at stash\//);
  assert.ok(!/not recoverable/.test(r.text));
  assert.ok(r.notice && /kept at stash\//.test(r.notice));
});

test("identical content is not an overwrite worth keeping, and the stash is pruned to fifty", async () => {
  await run({ path: "same.txt", content: "x\n" });
  const before = readdirSync(stashDir).length;
  await run({ path: "same.txt", content: "x\n" });
  assert.equal(readdirSync(stashDir).length, before, "no stash for a no-op rewrite");
  for (let i = 0; i < 60; i++) await run({ path: "churn.txt", content: `v${i}\n` });
  assert.ok(readdirSync(stashDir).length <= 50);
});
