import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * Estimated word timings for the face. The voice gives back audio and
 * nothing else, so the mouth is shaped from a sentence's words shared out
 * across the clip's length; what matters is that the shares are ordered,
 * never overlap, and stay inside the clip.
 */
const LIB = "../desktop/renderer/src/lib/word-timing.js";
type Timing = { words: string[]; wtimes: number[]; wdurations: number[] };
const { estimateWordTimes } = (await import(LIB)) as {
  estimateWordTimes: (t: string, d: number, o?: object) => Timing;
};

describe("estimated word timings", () => {
  test("words tile the clip in order and never overlap", () => {
    const r = estimateWordTimes("The quick brown fox jumps over the lazy dog.", 2400);
    assert.equal(r.words.length, 9);
    for (let i = 0; i < r.words.length; i++) {
      assert.ok(r.wdurations[i]! >= 0);
      if (i > 0) {
        assert.ok(
          r.wtimes[i]! >= r.wtimes[i - 1]! + r.wdurations[i - 1]!,
          `word ${i} starts at ${r.wtimes[i]} before word ${i - 1} ends`,
        );
      }
    }
    assert.ok(r.wtimes.at(-1)! + r.wdurations.at(-1)! <= 2400, "the last word ends inside the clip");
    assert.ok(r.wtimes[0]! >= 0 && r.wtimes[0]! <= 100, "a short lead-in before the first word");
  });

  test("longer words take longer, and punctuation adds a breath", () => {
    const r = estimateWordTimes("I understand completely", 1500);
    assert.ok(r.wdurations[2]! > r.wdurations[0]!, "completely outlasts I");
    const flat = estimateWordTimes("one two three four", 2000);
    const paused = estimateWordTimes("one two, three four", 2000);
    const gap = (t: Timing) => t.wtimes[2]! - (t.wtimes[1]! + t.wdurations[1]!);
    assert.ok(gap(paused) > gap(flat), `comma gap ${gap(paused)}ms vs ${gap(flat)}ms`);
  });

  test("edges: empty text, zero duration, unicode letters, one word", () => {
    assert.deepEqual(estimateWordTimes("", 1000), { words: [], wtimes: [], wdurations: [] });
    assert.deepEqual(estimateWordTimes("   ", 1000).words, []);
    const z = estimateWordTimes("hello there", 0);
    assert.deepEqual(z.wtimes, [0, 0]);
    assert.deepEqual(z.wdurations, [0, 0]);
    const u = estimateWordTimes("naïve café", 1000);
    assert.ok(u.wdurations[0]! > 0 && u.wdurations[1]! > 0, "accented letters count as letters");
    const one = estimateWordTimes("Done.", 500);
    assert.equal(one.words.length, 1);
    assert.ok(one.wdurations[0]! > 0);
  });
});
