import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The browse tool with acting enabled — a separate file because the flag is
 * read when config loads, and each test file is its own process, so this is
 * the one place the flag can be on without leaking into every other suite
 * (whose read-only assertions are the default posture being tested).
 *
 * Offline like the rest: argument handling, gating and rendering. Whether a
 * real click lands is a question only a real page answers.
 */
const scratch = mkdtempSync(join(tmpdir(), "enio-browse-act-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
// The bundled skills live in the checkout now, so a suite that redirects
// only the data dir would still load them into every prompt it measures.
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_BROWSER_ACT = "1";

const { browseTools, setBrowseSession } = await import("./tools/browse.js");
const { playwrightAvailable, closeBrowser } = await import("./tools/browser.js");

after(async () => {
  await closeBrowser();
  rmSync(scratch, { recursive: true, force: true });
});

describe("browse with ENIO_BROWSER_ACT=1", () => {
  const tool = browseTools[0];
  const skip = !tool;

  test("the schema offers control, text and enter", { skip }, () => {
    // The flag flips what the model is *offered*, not just what is accepted:
    // with it off these parameters are withheld for the same reason a dead-end
    // tool is, so their presence here is the flag observably working.
    const props = (tool!.parameters as any).properties;
    assert.equal(props.control?.type, "number");
    assert.equal(props.text?.type, "string");
    assert.equal(props.enter?.type, "boolean");
    assert.match(String(tool!.description), /control: <number>/);
  });

  test("a control number with no page open says so", { skip }, async () => {
    setBrowseSession("act-no-page");
    // Same failure shape as link: N before any page — the closed list this
    // number indexes into does not exist yet, so it fails by name.
    assert.match(String(await tool!.run({ control: 2 })), /No page open yet/);
  });
});
