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
const AUDIO_OUT = "../desktop/renderer/src/lib/audio-out.js";

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
    private done = false;
    addEventListener(name: string, fn: () => void) {
      (this.handlers[name] ??= []).push(fn);
    }
    // A real element fires "pause" when paused — the stub must too, because
    // settling the drain after stopSpeaking() DEPENDS on that event.
    pause() {
      this.done = true;
      for (const fn of this.handlers.pause ?? []) fn();
    }
    play() {
      setTimeout(() => {
        if (this.done) return;
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

  test("read-aloud splits the reply instead of sending it whole", async () => {
    const marks: Mark[] = [];
    let start = 0;
    installBrowserStubs(marks, () => start);
    const { speakAll } = (await import(SPEECH)) as any;

    start = Date.now();
    await speakAll(
      "The ocean covers most of the surface. It holds nearly all the water. " +
        "Its trenches reach past eleven kilometres.",
    );

    // Three requests, not one. Sending the reply whole meant one synthesis for
    // the entire thing and silence until it finished -- which grows with the
    // length of the answer, exactly when someone is least willing to wait.
    const synths = marks.filter((m) => m.kind === "synth");
    assert.equal(synths.length, 3, "each sentence should be its own utterance");

    // And the first one is audible after a single sentence's synthesis rather
    // than the whole reply's.
    assert.ok(
      marks[0]!.kind === "synth" && marks.find((m) => m.kind === "ended")!.at < 2 * (SYNTH_MS + PLAY_MS),
      "the first sentence should finish before the whole reply could be synthesised",
    );
  });
});

describe("spokenText", () => {
  test("reads the document, not the notation", async () => {
    const { spokenText } = await import(SPEECH);
    // The reported failure verbatim: a markdown reply was performed as
    // "hash hash Cold Brew asterisk asterisk" instead of read.
    assert.equal(
      spokenText("## Cold Brew\n\n- **Steep** grounds for `12` hours."),
      "Cold Brew\n\nSteep grounds for 12 hours.",
    );
    assert.equal(spokenText("see [the guide](https://example.com/a/b)"), "see the guide");
    // A bare URL becomes its host -- nobody wants a path read out.
    assert.equal(spokenText("docs at https://www.example.com/deep/path"), "docs at example.com");
    // A fenced block is named, never performed.
    assert.match(spokenText("Run this:\n```js\nconst x = 1;\n```"), /code block/);
    assert.ok(!spokenText("```").includes("`"), "a stray fence is dropped");
  });

  test("does not narrate emoji", async () => {
    const { spokenText } = await import(SPEECH);
    // Heard in voice mode: "Done rocket sparkles". Decoration again, read out.
    assert.equal(spokenText("Done 🚀✨ the build is green ✅"), "Done the build is green");
    // Composed sequences go whole: a flag, a skin-toned hand, a family.
    assert.equal(spokenText("hello 👋🏽 from 🇵🇹 👨‍👩‍👧"), "hello from");
    // A keycap keeps its digit; plain punctuation and currency are untouched.
    assert.equal(spokenText("press 1️⃣ then pay €5 — ok?"), "press 1 then pay €5 — ok?");
  });
});

describe("stopSpeaking settles the drain", () => {
  test("a speak() promise resolves after a mid-playback stop", async () => {
    const marks: Mark[] = [];
    let start = 0;
    installBrowserStubs(marks, () => start);
    const { speak, stopSpeaking } = (await import(SPEECH)) as any;

    start = Date.now();
    const done = speak("A very long sentence that will be stopped.");
    // Let synthesis finish and playback begin, then stop mid-play.
    await new Promise((r) => setTimeout(r, 90));
    stopSpeaking();

    // The promise must settle promptly — a paused element never fires
    // "ended", and before the pause listener this await hung forever,
    // which a voice loop awaiting the drain would inherit.
    const settled = await Promise.race([
      done.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 300)),
    ]);
    assert.equal(settled, true, "drain settled after stopSpeaking()");
  });

  test("speakAll settles when the last spoken sentence has played, even when the text ends in an emoji", async () => {
    const marks: Mark[] = [];
    let start = 0;
    installBrowserStubs(marks, () => start);
    const { speakAll } = (await import(SPEECH)) as any;

    start = Date.now();
    // The emoji is stripped, which leaves an empty last part; the promise
    // returned must still be the one for "Two!", not an already-settled one
    // for nothing -- that flipped the read-aloud button back at once.
    await speakAll("One. Two! 😊");
    const ended = marks.filter((m) => m.kind === "ended");
    assert.equal(ended.length, 2, "both sentences had played when speakAll settled");
  });

  test("onSpeaking reports busy for exactly the life of a run, and a stop ends it at once", async () => {
    const marks: Mark[] = [];
    let start = 0;
    installBrowserStubs(marks, () => start);
    const { speak, stopSpeaking, onSpeaking } = (await import(SPEECH)) as any;

    const seen: boolean[] = [];
    const off = onSpeaking((on: boolean) => seen.push(on));
    assert.deepEqual(seen, [false], "a new subscriber hears the current state first");

    start = Date.now();
    await speak("One.");
    assert.deepEqual(seen, [false, true, false]);

    const cut = speak("A very long sentence that will be stopped.");
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(seen.at(-1), true);
    stopSpeaking();
    assert.equal(seen.at(-1), false, "stopping is idle immediately, not when the cut clip settles");
    await cut;
    assert.deepEqual(seen.filter((x) => x).length, 2, "the interrupted run does not announce idle twice");
    off();
  });
});

/**
 * The sink seam: while the face is on screen, sentences go through it
 * instead of the element, with the queue and the stop semantics unchanged.
 */
describe("a speech sink", () => {
  test("receives each sentence in order while registered, and the element stays silent", async () => {
    const marks: Mark[] = [];
    let start = 0;
    installBrowserStubs(marks, () => start);
    const { speak, setSpeechSink } = (await import(SPEECH)) as any;
    const got: string[] = [];
    setSpeechSink({
      play: async (_blob: unknown, text: string) => {
        got.push(text);
        await new Promise((r) => setTimeout(r, 10));
      },
      stop() {},
    });
    try {
      start = Date.now();
      speak("One.");
      await speak("Two.");
      assert.deepEqual(got, ["One.", "Two."]);
      assert.equal(marks.filter((m) => m.kind === "ended").length, 0, "the element did not play");
    } finally {
      setSpeechSink(null);
    }
  });

  test("stopSpeaking stops the sink and the speak() promise still settles", async () => {
    const marks: Mark[] = [];
    let start = 0;
    installBrowserStubs(marks, () => start);
    const { speak, stopSpeaking, setSpeechSink } = (await import(SPEECH)) as any;
    let release: (() => void) | null = null;
    let stops = 0;
    // Like the real sink: the clip's promise settles only when stop() says so.
    setSpeechSink({
      play: () => new Promise<void>((r) => (release = r)),
      stop() {
        stops++;
        release?.();
      },
    });
    try {
      start = Date.now();
      const done = speak("One.");
      await new Promise((r) => setTimeout(r, SYNTH_MS + 30));
      stopSpeaking();
      await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("drain hung after stop")), 500))]);
      assert.equal(stops, 1);
    } finally {
      setSpeechSink(null);
    }
  });

  test("a sink that rejects before queuing falls back to the element", async () => {
    const marks: Mark[] = [];
    let start = 0;
    installBrowserStubs(marks, () => start);
    const { speak, setSpeechSink } = (await import(SPEECH)) as any;
    setSpeechSink({
      play: async () => {
        throw new Error("cannot decode");
      },
      stop() {},
    });
    try {
      start = Date.now();
      await speak("One.");
      assert.equal(marks.filter((m) => m.kind === "ended").length, 1, "the element said it instead");
    } finally {
      setSpeechSink(null);
    }
  });
});

/**
 * The start of a spoken reply. Two different losses, both silent: the first
 * word going unheard because the output was asleep when the clip started,
 * and the first sentence going unsaid for seconds because speech waited for
 * its full stop.
 */
describe("the first words of a reply", () => {
  test("an output that has just been woken is given time before the first clip", async () => {
    installBrowserStubs([], () => 0);
    const { speak, setSpeechSink, clearSpeechSink } = (await import(SPEECH)) as any;
    const { WARM_MS } = (await import(AUDIO_OUT)) as any;
    let primedAt = 0;
    let playedAt = 0;
    const sink = {
      prime() {
        if (!primedAt) primedAt = Date.now();
      },
      warmFor: () => (primedAt ? Date.now() - primedAt : 0),
      async play() {
        if (!playedAt) playedAt = Date.now();
      },
      stop() {},
    };
    setSpeechSink(sink);
    try {
      await speak("Hello.");
      assert.ok(primedAt > 0, "the output was woken when the sentence was queued");
      // Synthesis in the stub takes 120 ms, less than the warm-up: the clip
      // must wait out the rest, not start into an output still coming up.
      assert.ok(playedAt - primedAt >= WARM_MS - 15, `played ${playedAt - primedAt}ms after waking, wanted ${WARM_MS}`);

      // Already warm: the next sentence waits for nothing but its synthesis.
      const before = Date.now();
      playedAt = 0;
      await speak("Again.");
      assert.ok(playedAt - before < WARM_MS, `a warm output was made to wait ${playedAt - before}ms`);
    } finally {
      clearSpeechSink(sink);
    }
  });

  test("a primer starts once, is extended by each request, and lets go when nothing more is asked", async () => {
    const { createPrimer } = (await import(AUDIO_OUT)) as any;
    let clock = 0;
    let scheduled: { fn: () => void; at: number } | null = null;
    const started: string[] = [];
    const ctx = {
      state: "running",
      sampleRate: 100,
      destination: {},
      createBuffer: (_c: number, n: number) => ({ getChannelData: () => new Float32Array(n) }),
      createBufferSource: () => ({
        buffer: null,
        loop: false,
        connect() {},
        disconnect() {},
        start: () => started.push("start"),
        stop: () => started.push("stop"),
      }),
    };
    const primer = createPrimer(() => ctx, {
      now: () => clock,
      later: (fn: () => void, ms: number) => (scheduled = { fn, at: clock + ms }),
      cancel: () => (scheduled = null),
    });

    assert.equal(primer.warmFor(), 0, "asleep until asked");
    primer.prime(1000);
    clock = 400;
    primer.prime(1000);
    assert.deepEqual(started, ["start"], "one source, however often it is asked");
    assert.equal(primer.warmFor(), 400);
    assert.equal(scheduled!.at, 1400, "the later request extends the hold");
    // A shorter request does not cut a longer one short.
    primer.prime(100);
    assert.equal(scheduled!.at, 1400);

    clock = 1400;
    scheduled!.fn();
    assert.deepEqual(started, ["start", "stop"]);
    assert.equal(primer.warmFor(), 0);
    // A context that is gone is not an error, it is nothing to wake.
    createPrimer(() => null).prime();
    createPrimer(() => ({ state: "closed" })).prime();
  });

  test("the opening clause is ready before its sentence ends", async () => {
    const { takeFirstClause } = (await import(SPEECH)) as any;
    assert.deepEqual(
      takeFirstClause("The Santa Maria Trail is one of the top options in Sintra, and it is short enough"),
      { ready: ["The Santa Maria Trail is one of the top options in Sintra,"], rest: " and it is short enough" },
    );
    // A fragment is not worth a clip of its own: wait for more.
    assert.deepEqual(takeFirstClause("Well, that depends on what you"), { ready: [], rest: "Well, that depends on what you" });
    // …and the next boundary that is long enough is the one taken.
    assert.deepEqual(takeFirstClause("Well, that depends on what you want: speed or"), {
      ready: ["Well, that depends on what you want:"],
      rest: " speed or",
    });
    // A comma inside a number is not a clause boundary.
    assert.deepEqual(takeFirstClause("There are about 1,000 trails in the whole region and"), {
      ready: [],
      rest: "There are about 1,000 trails in the whole region and",
    });
    // A boundary still being typed is not one yet.
    assert.deepEqual(takeFirstClause("The trail is short and easy to follow,").ready, []);
    assert.deepEqual(takeFirstClause("It takes about an hour — less if you").ready, ["It takes about an hour —"]);
  });

  test("with no punctuation to cut at, a long opening breaks before a joining word", async () => {
    const { takeFirstClause } = (await import(SPEECH)) as any;
    assert.deepEqual(
      takeFirstClause("The best way to reach the old lighthouse is by the coast road because the inland"),
      { ready: ["The best way to reach the old lighthouse is by the coast road"], rest: " because the inland" },
    );
    // Not early: a short run before "and" is a list, not a clause.
    assert.deepEqual(takeFirstClause("Bread and butter and a little jam are all you need for").ready, []);
    // Punctuation, when it comes first, is the better place.
    assert.deepEqual(
      takeFirstClause("The best way to reach the lighthouse, which is old and lovely, is").ready,
      ["The best way to reach the lighthouse,"],
    );
  });
});
