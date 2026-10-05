import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * The renderer's hand-rolled SSE parser. Comment frames are closed
 * grammars: a value outside the list is no value, never a crash.
 */
const LIB = "../desktop/renderer/src/lib/agent.js";
const { parseSseEvent } = (await import(LIB)) as { parseSseEvent: (block: string) => Record<string, unknown> };

describe("comment frames", () => {
  test("mood is a closed list, beside basis and panel", () => {
    assert.equal(parseSseEvent(": mood happy").mood, "happy");
    assert.equal(parseSseEvent(": mood ecstatic").mood, null);
    assert.equal(parseSseEvent(": basis web").basis, "web");
    assert.equal(parseSseEvent(": basis vibes").basis, null);
    assert.deepEqual(parseSseEvent(": panel avatar").panel, { panel: "avatar", view: null });
  });

  test("a frame can carry a comment and data together", () => {
    const ev = parseSseEvent(`: mood sorry\ndata: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`);
    assert.equal(ev.mood, "sorry");
    assert.ok(String(ev.data).includes("hi"));
  });
});
