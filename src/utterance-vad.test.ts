import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * The endpointing math behind voice conversation, tested from node the way
 * speech.test.ts tests the speech queue: computed specifier, injected
 * timing, zero AudioContext. The failures these guard are all silent —
 * a tracker that fires on a door slam makes the assistant answer noises,
 * and one that ends on a mid-sentence pause answers half a question.
 */
const LIB = "../desktop/renderer/src/lib/utterance-recorder.js";

// 85ms blocks ≈ a 48kHz context with 4096-sample ScriptProcessor blocks.
const BLOCK_MS = 85;
const LOUD = 0.05;
const QUIET = 0.001;

async function tracker(overrides: Record<string, number> = {}) {
  const { createVadTracker } = (await import(LIB)) as any;
  return createVadTracker({ blockMs: BLOCK_MS, ...overrides });
}

const pushN = (t: any, rms: number, n: number): string[] => {
  const events: string[] = [];
  for (let i = 0; i < n; i++) {
    const e = t.push(rms);
    if (e) events.push(e);
  }
  return events;
};

describe("the VAD tracker", () => {
  test("silence produces no events, forever", async () => {
    const t = await tracker();
    assert.deepEqual(pushN(t, QUIET, 500), []);
  });

  test("sustained speech starts after exactly ONSET_BLOCKS", async () => {
    const { ONSET_BLOCKS } = (await import(LIB)) as any;
    const t = await tracker();
    const events: string[] = [];
    for (let i = 0; i < ONSET_BLOCKS; i++) {
      const e = t.push(LOUD);
      if (e) events.push(`${e}@${i + 1}`);
    }
    assert.deepEqual(events, [`start@${ONSET_BLOCKS}`]);
  });

  test("a two-block bang is not speech", async () => {
    const t = await tracker();
    assert.deepEqual(pushN(t, LOUD, 2), []);
    assert.deepEqual(pushN(t, QUIET, 50), [], "and the run resets on silence");
    assert.deepEqual(pushN(t, LOUD, 2), []);
  });

  test("a mid-sentence pause does not end the utterance", async () => {
    const t = await tracker();
    pushN(t, LOUD, 10); // start + voiced
    // 500ms of pause: under HANG_MS, so nothing fires.
    assert.deepEqual(pushN(t, QUIET, Math.floor(500 / BLOCK_MS)), []);
    assert.deepEqual(pushN(t, LOUD, 5), [], "speech resumes inside the same utterance");
  });

  test("a real silence ends it; a blip is dropped", async () => {
    const hangBlocks = Math.ceil(1000 / BLOCK_MS);

    const long = await tracker();
    pushN(long, LOUD, 10); // ~850ms voiced ≥ MIN_UTTERANCE_MS
    assert.deepEqual(pushN(long, QUIET, hangBlocks), ["end"]);

    const blip = await tracker();
    pushN(blip, LOUD, 4); // ~340ms voiced < 400ms minimum
    assert.deepEqual(pushN(blip, QUIET, hangBlocks), ["drop"]);
  });

  test("a monologue flushes at the cap and keeps going", async () => {
    const t = await tracker({ maxMs: 30000 });
    const capBlocks = Math.ceil(30000 / BLOCK_MS);
    const events = pushN(t, LOUD, capBlocks + 10);
    assert.equal(events[0], "start");
    assert.ok(events.includes("flush"), "cap flushes");
    // Still in speech: a following silence ENDS (the continuation was voiced).
    const after = pushN(t, QUIET, Math.ceil(1000 / BLOCK_MS));
    assert.deepEqual(after, ["end"]);
  });

  test("reset clears mid-utterance state", async () => {
    const t = await tracker();
    pushN(t, LOUD, 10);
    t.reset();
    // No end fires for the abandoned utterance; a fresh onset is required.
    assert.deepEqual(pushN(t, QUIET, 30), []);
    assert.deepEqual(pushN(t, LOUD, 2), []);
  });

  test("blockRms measures what it says", async () => {
    const { blockRms } = (await import(LIB)) as any;
    assert.equal(blockRms(new Float32Array([0, 0, 0, 0])), 0);
    const half = blockRms(new Float32Array([0.5, -0.5, 0.5, -0.5]));
    assert.ok(Math.abs(half - 0.5) < 1e-6);
  });
});
