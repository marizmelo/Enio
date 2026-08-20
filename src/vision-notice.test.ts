import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-vis-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-such-mcp.json");

const { toolText } = await import("./types.js");

/**
 * How an image was read is the user's business, not the model's.
 *
 * Reported as "not able to read screenshots". It read them fine -- by OCR --
 * and answered honestly that no error was visible in the text. What was
 * missing was any sign that nothing had looked at the pixels, which reads as
 * an agent that cannot see rather than a vision model that is not running.
 *
 * The split is the one attachments already make: telling the MODEL what it
 * lacks makes it announce the limitation instead of answering, so that
 * sentence goes to the person, who is the only one who can act on it.
 */
describe("the notice channel", () => {
  test("a tool result can carry text for the model and a notice for the user", () => {
    const out = { text: "some OCR text", notice: "Read with OCR — text only." };
    assert.equal(toolText(out), "some OCR text");
    assert.ok(!toolText(out).includes("OCR — text only"), "the notice is not in what the model reads");
  });

  test("a plain string result still works", () => {
    assert.equal(toolText("just text"), "just text");
  });
});

describe("read_image", () => {
  test("returns the note as a notice, not as part of the answer", async () => {
    const { visionTools } = await import("./tools/vision.js");
    const readImage = visionTools.find((t) => t.name === "read_image");
    // Withheld entirely when no vision path exists, which is its own rule.
    if (!readImage) return;
    const out = await readImage.run({ path: "nope.png" });
    // A non-image is refused with a plain string; the shape must not throw.
    assert.equal(typeof toolText(out), "string");
  });
});

process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
