import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CATALOGUE } from "./model-catalogue.js";

// The registry this suite builds must not depend on the developer's real
// machine-wide settings (desktop-control consent, model choice).
process.env.ENIO_MACHINE_STATE_DIR = join(mkdtempSync(join(tmpdir(), "enio-docs-")), "machine");

/**
 * The documentation, checked against the code it describes.
 *
 * Prose drifts silently and nothing complains. In one session the README
 * accumulated four false claims — a tool count that had changed, a permission
 * rule that applied to two recipes rather than three, a compilation target
 * that had moved, and whole features missing. None of it was visible without
 * reading the code beside it.
 *
 * Not everything in a document is checkable, and pretending otherwise would
 * produce a test that fails on every rewording. What *is* checkable is the
 * nouns: an environment variable, a tool, a recipe, a CLI command either
 * exists or does not. Those are also exactly what a reader copies and runs, so
 * they are the sentences where being wrong costs the most.
 */

const ROOT = join(import.meta.dirname, "..");

/** Every .ts source under a directory, so an env var read anywhere counts. */
function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSources(full));
    else if (entry.name.endsWith(".ts")) out.push(readFileSync(full, "utf8"));
  }
  return out;
}
const DOCS = join(ROOT, "docs");

const pages = readdirSync(DOCS)
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ file: f, text: readFileSync(join(DOCS, f), "utf8") }));

const allDocs = pages.map((p) => p.text).join("\n") + readFileSync(join(ROOT, "README.md"), "utf8");

/** Text outside fenced code blocks — prose claims, not shell transcripts. */
function prose(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

describe("the docs describe the code that exists", () => {
  test("every documented ENIO_ variable is one config reads", () => {
    // Scanned across the whole source, not just config.ts: several are
    // resolved where they are used rather than at startup, and a test that
    // only knew about config.ts would call those inventions.
    const sources = walkSources(join(ROOT, "src"));
    const known = new Set<string>();
    for (const src of sources) {
      for (const m of src.matchAll(/env\("([A-Z_]+)"\)/g)) known.add(`ENIO_${m[1]}`);
      for (const m of src.matchAll(/\bENIO_[A-Z_]+/g)) known.add(m[0]);
    }

    const documented = new Set([...allDocs.matchAll(/\bENIO_[A-Z_]+/g)].map((m) => m[0]));
    const invented = [...documented].filter((v) => !known.has(v));
    assert.deepEqual(invented, [], `documented but never read: ${invented.join(", ")}`);
  });

  test("every tool named in the docs is a real tool", async () => {
    const { buildRegistry } = await import("./tools/index.js");
    const registry = await buildRegistry();
    // Tools withheld by configuration on this machine still exist as names.
    const { builtinRecipes } = await import("./tools/desktop.js");
    const known = new Set([
      ...registry.all.map((t) => t.name),
      // Recipe names share the shape of tool names and are checked separately.
      ...builtinRecipes().map((r) => r.name),
      // Real, but withheld on a machine without the relevant config or flag.
      "web_search", "search_email", "read_email", "send_email",
      "web_fetch_rendered", "run_applescript", "take_screenshot", "propose_plan",
    ]);

    // Backticked lower_snake_case words are how the docs name tools. Anything
    // matching that shape and ending in a known tool-ish suffix is checked.
    const mentioned = new Set(
      [...prose(allDocs).matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]!),
    );
    const toolish = [...mentioned].filter((n) =>
      /^(web_|read_|write_|list_|run_|send_|search_|open_|take_|propose_|mac_|set_)/.test(n),
    );
    const missing = toolish.filter((n) => !known.has(n));
    assert.deepEqual(missing, [], `documented tools that do not exist: ${missing.join(", ")}`);
  });

  test("every recipe named in the docs is a real recipe", async () => {
    const { builtinRecipes } = await import("./tools/desktop.js");
    const known = new Set(builtinRecipes().map((r) => r.name));
    // The recipe table is the one place they are all listed by name.
    const macDoc = readFileSync(join(DOCS, "mac-control.md"), "utf8");
    // Scoped to the recipe table: the plan-step table below it has the same
    // row shape and lists step kinds, which are not recipes.
    const table = /\| Recipe \| Returns \| Needs \|([\s\S]*?)\n\n/.exec(macDoc);
    assert.ok(table, "the recipe table should be findable");
    const named = [...table[1]!.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]!);
    const unknown = named.filter((n) => !known.has(n));
    assert.deepEqual(unknown, [], `documented recipes that do not exist: ${unknown.join(", ")}`);
    // And the reverse: a recipe the model can pick should be findable.
    const undocumented = [...known].filter((n) => !macDoc.includes(n));
    assert.deepEqual(undocumented, [], `recipes with no documentation: ${undocumented.join(", ")}`);
  });

  test("every agent named in the docs is a real agent", async () => {
    const { SPECIALISTS } = await import("./specialists.js");
    const known = new Set(SPECIALISTS.map((s) => s.name));
    const agentDoc = readFileSync(join(DOCS, "agents.md"), "utf8");
    const named = [...agentDoc.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]!);
    assert.ok(named.length > 0, "the agents table should list agents");
    for (const n of named) assert.ok(known.has(n), `documented agent does not exist: ${n}`);
    for (const s of SPECIALISTS) {
      assert.ok(agentDoc.includes(s.name), `agent with no documentation: ${s.name}`);
    }
  });

  test("every page has the front matter Pages needs", () => {
    // A page without front matter still renders on github.com and silently
    // vanishes from the site's navigation, which is the kind of half-broken
    // that survives review.
    for (const { file, text } of pages) {
      assert.ok(text.startsWith("---\n"), `${file} is missing front matter`);
      assert.match(text, /^title: .+$/m, `${file} has no title`);
      assert.match(text, /^nav_order: \d+$/m, `${file} has no nav_order`);
    }
  });

  test("the index links to every page", () => {
    // Browsing /docs on GitHub renders README.md, so it is the only way in
    // for anyone who has not enabled Pages. A page missing from it is a page
    // nobody finds — and adding a page without touching the index is the
    // easiest possible mistake.
    const index = pages.find((p) => p.file === "README.md");
    assert.ok(index, "docs/README.md is the index GitHub renders");
    for (const { file } of pages) {
      if (file === "README.md") continue;
      assert.ok(
        index.text.includes(`(${file})`),
        `${file} is not linked from the index`,
      );
    }
  });

  test("internal doc links point at pages that exist", () => {
    const names = new Set(pages.map((p) => p.file.replace(/\.md$/, "")));
    for (const { file, text } of pages) {
      for (const [, target] of text.matchAll(/\]\((?!https?:|#)([^)#]+)\)/g)) {
        const clean = target!.replace(/\.md$/, "").replace(/^\.\//, "");
        if (clean.startsWith("images/")) continue;
        assert.ok(names.has(clean), `${file} links to missing page: ${target}`);
      }
    }
  });
});

/**
 * The picker and the page are two lists of the same thing, and the one that
 * rots is the page: adding a model is a code change, and nothing about it
 * forces a trip to the docs. A reader who downloads from a table missing two
 * entries never learns the other two exist.
 */
describe("the model catalogue", () => {
  const models = readFileSync(join(DOCS, "models.md"), "utf8");

  test("every downloadable model is documented", () => {
    for (const model of CATALOGUE) {
      assert.ok(models.includes(model.id), `docs/models.md does not mention ${model.id}`);
    }
  });

  test("documented sizes match the measured ones", () => {
    for (const model of CATALOGUE) {
      // The table writes 2.3GB for 2.28e9 bytes; the check is that nobody
      // rounded to a different number, not that the text is byte-exact.
      const expected = `${(model.bytes / 1e9).toFixed(1)}GB`;
      const row = models.split("\n").find((line) => line.includes(`\`${model.id}\``));
      assert.ok(row, `no table row for ${model.id}`);
      assert.ok(
        row.includes(expected),
        `docs/models.md lists ${model.id} at a size other than ${expected}: ${row.trim()}`,
      );
    }
  });
});
