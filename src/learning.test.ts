import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-learn-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_MCP_CONFIG = join(scratch, "none.json");

const learning = await import("./memory/learning.js");
const { closeDb } = await import("./memory/db.js");
const { SPECIALISTS, getSpecialist, toolsFor, DEFAULT_SPECIALIST } =
  await import("./specialists.js");
const { buildRegistry } = await import("./tools/index.js");
const { BACKENDS, resolveBackend } = await import("./backends.js");

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

describe("preferences", () => {
  test("adds and lists", () => {
    assert.equal(learning.addPreference("Answer concisely").added, true);
    assert.equal(learning.addPreference("Never use bullet points").added, true);
    const prefs = learning.listPreferences();
    assert.equal(prefs.length, 2);
  });

  test("refuses duplicates", () => {
    const second = learning.addPreference("Answer concisely");
    assert.equal(second.added, false);
    assert.equal(second.reason, "already set");
  });

  test("all preferences are injected, unlike facts which are ranked", () => {
    const block = learning.preferenceBlock();
    assert.match(block, /Answer concisely/);
    assert.match(block, /Never use bullet points/);
  });

  test("caps how many reach the prompt", () => {
    for (let i = 0; i < 20; i++) learning.addPreference(`Directive number ${i}`);
    const lines = learning.preferenceBlock().split("\n").filter((l) => l.startsWith("- "));
    assert.ok(lines.length <= 12, `expected <= 12 injected, got ${lines.length}`);
    // The newest survive — those are the ones the user most recently meant.
    assert.match(learning.preferenceBlock(), /Directive number 19/);
  });

  test("removes by id", () => {
    const target = learning.listPreferences()[0]!;
    assert.equal(learning.removePreference(String(target.id)), true);
    assert.ok(!learning.listPreferences().some((p) => p.id === target.id));
  });

  test("rejects trivially short input", () => {
    assert.equal(learning.addPreference("x").added, false);
  });
});

describe("exemplars", () => {
  test("stores a question and answer pair", async () => {
    const result = await learning.addExemplar(
      "how do I list files",
      "Use list_dir with the path you want. It returns names and sizes.",
    );
    assert.equal(result.added, true);
    assert.equal(learning.listExemplars().length, 1);
  });

  test("updates rather than duplicating on the same question", async () => {
    await learning.addExemplar("how do I list files", "A better second answer entirely.");
    const all = learning.listExemplars();
    assert.equal(all.length, 1);
    assert.match(all[0]!.answer, /better second answer/);
  });

  test("refuses answers too long to serve as examples", async () => {
    const result = await learning.addExemplar("a question", "x".repeat(3000));
    assert.equal(result.added, false);
    assert.match(result.reason ?? "", /too long/);
  });

  test("returns nothing rather than bad matches when embeddings are down", async () => {
    // No embedding model is reachable in this environment, so relevantExemplars
    // must return [] rather than falling back to lexical matching. A loosely
    // related example is worse than none — the model imitates its shape and
    // answers the wrong question.
    const found = await learning.relevantExemplars("something completely unrelated");
    assert.deepEqual(found, []);
  });
});

describe("specialists", () => {
  test("every specialist has a non-empty distinct tool set", () => {
    for (const s of SPECIALISTS) {
      assert.ok(s.tools.length > 0, `${s.name} has no tools`);
      assert.ok(s.systemPrompt.length > 50, `${s.name} prompt is too thin`);
    }
  });

  test("no specialist exceeds a small tool count", () => {
    // The entire point of routing is keeping each menu short. If a specialist
    // grows past this, it has stopped being a specialist.
    for (const s of SPECIALISTS) {
      assert.ok(s.tools.length <= 6, `${s.name} exposes ${s.tools.length} tools`);
    }
  });

  test("unknown names fall back to the generalist", () => {
    assert.equal(getSpecialist("nonexistent").name, DEFAULT_SPECIALIST);
  });

  test("filters a registry down to the specialist's tools", async () => {
    const registry = await buildRegistry();
    const coder = getSpecialist("coder");
    const names = toolsFor(coder, registry).map((t) => t.name);

    assert.ok(names.includes("read_file"));
    assert.ok(names.includes("run_command"));
    assert.ok(!names.includes("web_fetch"), "coder should not see web tools");
    assert.ok(!names.includes("remember"), "coder should not see memory writes");
  });

  test("researcher gets web tools and no shell", async () => {
    const registry = await buildRegistry();
    const names = toolsFor(getSpecialist("researcher"), registry).map((t) => t.name);
    assert.ok(names.includes("web_fetch"));
    assert.ok(!names.includes("run_command"), "researcher must not have shell access");
  });

  test("the generalist is nearly toolless, making it a safe fallback", async () => {
    const registry = await buildRegistry();
    const names = toolsFor(getSpecialist("generalist"), registry).map((t) => t.name);
    assert.ok(!names.includes("run_command"));
    assert.ok(!names.includes("write_file"));
  });
});

describe("backends", () => {
  test("maple is the default", () => {
    assert.equal(resolveBackend(undefined).id, "maple");
  });

  test("throws helpfully on an unknown id", () => {
    assert.throws(() => resolveBackend("gpt5"), /Unknown backend.*Available/s);
  });

  test("only mlx-lm claims unlimited token support", () => {
    // This flag guards a real incompatibility: max_tokens:-1 is a 400 on Ollama.
    assert.equal(BACKENDS.maple!.supportsUnlimitedTokens, true);
    assert.equal(BACKENDS.ollama!.supportsUnlimitedTokens, false);
    assert.equal(BACKENDS.lmstudio!.supportsUnlimitedTokens, false);
  });

  test("every backend has a loopback base url", () => {
    for (const b of Object.values(BACKENDS)) {
      assert.match(b.baseUrl, /^http:\/\/127\.0\.0\.1:/, `${b.id} should be local`);
      assert.ok(b.notes.length > 10, `${b.id} needs usage notes`);
    }
  });
});
