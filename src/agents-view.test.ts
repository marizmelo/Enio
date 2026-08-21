import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-agview-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

const { agentsView } = await import("./agents-view.js");
const { SPECIALISTS } = await import("./specialists.js");
const { buildRegistry } = await import("./tools/index.js");
const { closeDb } = await import("./memory/db.js");

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * The management panel's data. Everything derived, nothing stored -- a
 * stored copy would drift the first time a grant or a flag changed, and a
 * panel that drifts teaches people to stop believing it.
 */
describe("the agents view", () => {
  test("every agent appears, at or under the six-tool ceiling", async () => {
    const view = agentsView(await buildRegistry());
    assert.equal(view.length, SPECIALISTS.length);
    for (const agent of view) {
      assert.ok(agent.tools.length <= 6, `${agent.name} shows ${agent.tools.length} tools`);
      assert.ok(agent.description.length > 10, `${agent.name} has a real description`);
    }
  });

  test("a tool that is not configured shows as withheld, not hidden", async () => {
    // In this scratch environment no account exists and no IMAP is set, so
    // the mail agent's tools are declared but absent from the registry. The
    // panel must show them crossed out rather than pretend the agent is
    // toolless -- "what could this do if I set it up" is half the point.
    const view = agentsView(await buildRegistry());
    const mail = view.find((a) => a.name === "mail")!;
    const search = mail.tools.find((t) => t.name === "search_email")!;
    assert.equal(search.available, false);
    assert.match(search.description, /withheld/i);
    // And a tool that is always there reads as available.
    const coder = view.find((a) => a.name === "coder")!;
    assert.equal(coder.tools.find((t) => t.name === "read_file")!.available, true);
  });

  test("skills attach to the agents that can act on them", async () => {
    // Derived from allowed-tools overlap: commit-message needs run_command,
    // so it belongs to the coder and not to the librarian.
    process.env.ENIO_BUILTIN_SKILLS = "";
    delete process.env.ENIO_BUILTIN_SKILLS;
    const view = agentsView(await buildRegistry());
    const coder = view.find((a) => a.name === "coder")!;
    const librarian = view.find((a) => a.name === "librarian")!;
    assert.ok(coder.skills.includes("commit-message"), coder.skills.join(","));
    assert.ok(!librarian.skills.includes("commit-message"));
  });
});
