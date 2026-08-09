import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * The renderer's speech queue, tested here because the failure it guards
 * against is silent: replacing the prefetch with a plain await still works,
 * still plays every sentence in order, and only sounds wrong -- a pause after
 * every full stop, which is not something any other test would notice.
 *
 * Loaded through a computed specifier so TypeScript treats the plain-JS
 * renderer module as untyped rather than demanding a declaration for it.
 */
const SPEECH = "../desktop/renderer/src/lib/speech.js";

const SYNTH_MS = 120;
const PLAY_MS = 200;

interface Mark {
  kind: "synth" | "ended";
  at: number;
}

function installBrowserStubs(marks: Mark[], t0: () => number) {
  (globalThis as any).window = { maple: null };
  (globalThis as any).URL.createObjectURL = () => "blob:stub";
  (globalThis as any).URL.revokeObjectURL = () => {};

  globalThis.fetch = (async () => {
    marks.push({ kind: "synth", at: Date.now() - t0() });
    await new Promise((r) => setTimeout(r, SYNTH_MS));
    return { ok: true, blob: async () => ({}) } as unknown as Response;
  }) as typeof fetch;

  (globalThis as any).Audio = class {
    private handlers: Record<string, Array<() => void>> = {};
    addEventListener(name: string, fn: () => void) {
      (this.handlers[name] ??= []).push(fn);
    }
    pause() {}
    play() {
      setTimeout(() => {
        marks.push({ kind: "ended", at: Date.now() - t0() });
        for (const fn of this.handlers.ended ?? []) fn();
      }, PLAY_MS);
      return Promise.resolve();
    }
  };
}

describe("spoken replies", () => {
  test("the next sentence is synthesised while the current one plays", async () => {
    const marks: Mark[] = [];
    let start = 0;
    installBrowserStubs(marks, () => start);
    const { speak } = (await import(SPEECH)) as any;

    start = Date.now();
    speak("One.");
    speak("Two.");
    await speak("Three.");

    const synths = marks.filter((m) => m.kind === "synth");
    const ended = marks.filter((m) => m.kind === "ended");
    assert.equal(synths.length, 3, "every sentence should be synthesised");
    assert.equal(ended.length, 3, "every sentence should be played");

    // The point of the whole queue: sentence two is already being made before
    // sentence one has finished being read. Synthesising in lockstep would put
    // this after the first "ended", which is the pause you hear.
    assert.ok(
      synths[1]!.at < ended[0]!.at,
      `second synthesis began at ${synths[1]!.at}ms but the first sentence ` +
        `only finished at ${ended[0]!.at}ms — playback is waiting on synthesis`,
    );

    // And the gap between sentences is playback-bound, not synthesis-bound:
    // three sentences should take about 3 x PLAY_MS plus one synthesis, not
    // three of each.
    const total = ended[2]!.at;
    assert.ok(
      total < 3 * (PLAY_MS + SYNTH_MS) * 0.85,
      `three sentences took ${total}ms, close to the fully serial ${3 * (PLAY_MS + SYNTH_MS)}ms`,
    );
  });
});
