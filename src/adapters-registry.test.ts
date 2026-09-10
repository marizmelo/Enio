import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-registry-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
process.env.ENIO_MODEL = "mlx-community/Qwen3-4B-Instruct-2507-4bit";

const reg = await import("./adapters.js");
const { adapterPathFor } = await import("./model-settings.js");
const { recordTurn } = await import("./memory/traces.js");
const { closeDb } = await import("./memory/db.js");

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

/** A staged adapter: the two files the server resolves. */
function stage(tag: string): string {
  const dir = join(scratch, "staging-" + tag);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "adapters.safetensors"), tag);
  writeFileSync(join(dir, "adapter_config.json"), "{}");
  return dir;
}
const gate = (right: number) => ({
  base: { toolRight: 12, total: 15, jsonValid: 10, jsonTotal: 10 },
  adapter: { toolRight: right, total: 15, jsonValid: 11, jsonTotal: 11 },
});
const installed = () => readFileSync(join(reg.adapterDir("coder"), "adapters.safetensors"), "utf8");

describe("the adapter registry", () => {
  test("a recorded version installs, and the next one supersedes it without deleting it", () => {
    const v1 = reg.recordAdapterVersion("coder", stage("one"), { trainer: "mlx", rows: 65, gate: gate(14) });
    assert.equal(v1.version, 1);
    assert.equal(installed(), "one");
    assert.ok(adapterPathFor("coder"), "the server resolves the installed version");

    const v2 = reg.recordAdapterVersion("coder", stage("two"), { trainer: "mlx", rows: 83, gate: gate(15) });
    assert.equal(v2.version, 2);
    assert.equal(installed(), "two");
    const history = reg.adapterHistory("coder");
    assert.deepEqual(history.map((h) => [h.version, h.active]), [[1, false], [2, true]]);
    assert.ok(existsSync(join(reg.adapterDir("coder"), "versions", "1", "adapters.safetensors")), "v1 stays on disk");
  });

  test("rollback is choosing the previous version, not deleting the current one", () => {
    const r = reg.rollbackAdapter("coder");
    assert.deepEqual(r, { ok: true, version: 1 });
    assert.equal(installed(), "one");
    assert.deepEqual(reg.adapterHistory("coder").map((h) => [h.version, h.active]), [[1, true], [2, false]]);
    assert.ok(existsSync(join(reg.adapterDir("coder"), "versions", "2", "adapters.safetensors")), "v2 stays on disk");
    assert.equal(reg.rollbackAdapter("coder").ok, false, "nothing before v1");
  });

  test("off retires the adapter: the specialist degrades to the bare base, history intact", () => {
    assert.equal(reg.retireAdapter("coder"), true);
    assert.equal(adapterPathFor("coder"), null);
    assert.equal(reg.adapterHistory("coder").length, 2);
    assert.equal(reg.activeAdapterVersion("coder"), null);
    assert.equal(reg.retireAdapter("coder"), false, "a second off has nothing to remove");
  });

  test("the trainer seam names its platform instead of failing inside a spawn", () => {
    const t = reg.trainerFor();
    // This scratch has no MLX runtime, so on a Mac the answer is "install",
    // and anywhere else it is "no trainer for this platform yet".
    assert.equal(t.available, false);
    assert.ok(t.reason && t.reason.length > 20);
  });
});

/* ------------------------------------------------------------------ */

const turn = (
  id: string,
  question: string,
  steps: Array<Partial<{ kind: "tool" | "model"; name: string; error: string; repaired: boolean; scavenged: boolean }>>,
  extra: Partial<{ reply: string; iterations: number; startedAt: number }> = {},
) =>
  recordTurn({
    sessionId: id,
    question,
    reply: extra.reply ?? "Done.",
    specialist: "coder",
    systemPrompt: "",
    memoryBlock: "",
    startedAt: extra.startedAt ?? Date.now(),
    durationMs: 100,
    iterations: extra.iterations ?? 1,
    steps: steps.map((s, i) => ({
      seq: i,
      kind: s.kind ?? "tool",
      name: s.name ?? "read_file",
      args: "{}",
      output: "ok",
      error: s.error ?? null,
      repaired: s.repaired ?? false,
      scavenged: s.scavenged ?? false,
    })),
  });

describe("mining the traces for the loop", () => {
  test("failures are the turns that went wrong in ways the traces can see, each with its reasons", () => {
    turn("s1", "read notes.md", [{ kind: "tool", name: "read_file" }]);
    turn("s2", "edit the config", [{ kind: "tool", name: "edit_file", error: "Error: old_string not found" }]);
    turn("s3", "run the tests", [{ kind: "model", repaired: true }, { kind: "tool", name: "run_command" }]);
    turn("s4", "why does it crash", [{ kind: "tool" }], { iterations: 8 });
    turn("s5", "verify my app", [{ kind: "tool" }], { reply: "I could not produce an answer for this one — the reply ran out of room twice." });
    const cases = reg.failureCases("coder");
    const byQ = Object.fromEntries(cases.map((c) => [c.question, c.reasons]));
    assert.ok(!("read notes.md" in byQ), "a clean turn is not a failure");
    assert.match(byQ["edit the config"]!.join(";"), /tool errors: edit_file/);
    assert.match(byQ["run the tests"]!.join(";"), /repaired/);
    assert.match(byQ["why does it crash"]!.join(";"), /iteration cap/);
    assert.match(byQ["verify my app"]!.join(";"), /no usable answer/);
  });

  test("material counts only clean tool-using turns, and only since the active version", () => {
    // Everything so far is before any version: one clean turn (s1).
    assert.equal(reg.materialSince("coder").clean, 1);
    reg.recordAdapterVersion("coder", stage("three"), { trainer: "mlx", rows: 1, gate: gate(15) });
    assert.equal(reg.materialSince("coder").clean, 0, "the version's training time resets the count");
    turn("s6", "list the folder", [{ kind: "tool", name: "read_file" }], { startedAt: Date.now() + 1000 });
    assert.equal(reg.materialSince("coder").clean, 1);
  });
});
