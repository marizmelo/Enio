import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-cloud-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const cloud = await import("./cloud.js");

after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Sending a handoff to a frontier model.
 *
 * DECISIONS rejected a frontier key wired in as an *automatic fallback* --
 * "quiet is the problem, since data leaving the machine is exactly the
 * decision that must stay loud". The capability was never the objection, the
 * quietness was, so what has to hold here is that every send stays a
 * deliberate act: nothing configured by default, no tool able to reach it,
 * and a key that goes in and never comes back out.
 */
describe("cloud targets", () => {
  test("nothing is set up until someone says so", () => {
    assert.equal(cloud.cloudTarget(), null);
    assert.equal(cloud.cloudConfigured(), false);
  });

  test("a send with no target set is refused rather than guessed at", async () => {
    const result = await cloud.sendToCloud("some handoff");
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /No cloud target/);
  });

  test("detection reports what is installed without running anything", async () => {
    const targets = await cloud.cloudTargets();
    const ids = targets.map((t) => t.id);
    // A closed list: an unknown binary's flags cannot be guessed, and a wrong
    // guess hangs a send inside an interactive prompt.
    assert.deepEqual(ids, ["claude", "gemini", "codex", "anthropic", "openai"]);
    for (const t of targets) {
      assert.ok(t.detail, `${t.id} should say why it is or is not available`);
    }
    // With no key and no env var, the API targets are unavailable.
    assert.equal(targets.find((t) => t.id === "anthropic")!.available, false);
  });

  test("an unknown target is refused", () => {
    assert.throws(() => cloud.setCloudTarget("wizard"), /Unknown target/);
    assert.throws(() => cloud.setCloudKey("wizard", "sk-x"), /Unknown provider/);
  });
});

describe("keys", () => {
  test("a saved key makes its provider available, and is never listed", async () => {
    cloud.setCloudKey("anthropic", "sk-ant-secret");
    const targets = await cloud.cloudTargets();
    const anthropic = targets.find((t) => t.id === "anthropic")!;
    assert.equal(anthropic.available, true);
    assert.equal(anthropic.detail, "key saved");
    // The whole listing must not carry the credential anywhere in it.
    assert.ok(!JSON.stringify(targets).includes("sk-ant-secret"), "the key leaked into the listing");
  });

  test("the key file is owner-only", () => {
    const mode = statSync(cloud.cloudSettingsFile()).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });

  test("clearing a key also drops it as the target, so the state stays honest", () => {
    cloud.setCloudTarget("anthropic");
    assert.equal(cloud.cloudTarget(), "anthropic");
    cloud.setCloudKey("anthropic", "");
    assert.equal(cloud.cloudTarget(), null, "a target with no key would fail confusingly later");
    assert.ok(!readFileSync(cloud.cloudSettingsFile(), "utf8").includes("sk-ant-secret"));
  });

  test("an exported key counts, without being copied into the file", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
    const anthropic = (await cloud.cloudTargets()).find((t) => t.id === "anthropic")!;
    assert.equal(anthropic.available, true);
    assert.match(anthropic.detail, /ANTHROPIC_API_KEY/);
    assert.ok(!readFileSync(cloud.cloudSettingsFile(), "utf8").includes("sk-ant-from-env"));
    delete process.env.ANTHROPIC_API_KEY;
  });
});

describe("the model cannot escalate on its own", () => {
  test("no tool reaches the cloud path", async () => {
    // The structural half of the DECISIONS rule: the model packages a
    // handoff, a person sends it. If a tool ever appears here, escalation
    // becomes something the model can talk itself into — or be talked into
    // by a page it read.
    const { buildRegistry } = await import("./tools/index.js");
    const names = (await buildRegistry()).all.map((t) => t.name);
    for (const name of names) {
      assert.ok(!/cloud|frontier|escalat/i.test(name), `${name} looks like a cloud escape hatch`);
    }
  });
});
