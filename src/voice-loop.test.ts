import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * The voice-conversation state machine with every dependency faked. The
 * tests that matter most are the ugly ones: dependencies that never settle,
 * interrupts that race resolutions, turns the user starts by typing — the
 * machine must reach a sane state in all of them, because a wedged voice
 * mode holds the microphone.
 */
const LIB = "../desktop/renderer/src/lib/voice-loop.js";

interface Deps {
  startRecorder?: unknown;
  transcribe?: unknown;
  sendTurn?: unknown;
  speakDone?: unknown;
  isBusy?: unknown;
  interruptTurn?: unknown;
  onState?: unknown;
  onError?: unknown;
  guardMs?: number;
  delay?: unknown;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function build(overrides: Deps = {}) {
  const { createVoiceLoop } = (await import(LIB)) as any;
  const calls = { pause: 0, resume: 0, stop: 0, interruptTurn: 0 };
  const states: string[] = [];
  let utter: ((wav: unknown) => Promise<void>) | null = null;

  const loop = createVoiceLoop({
    startRecorder: async ({ onUtterance }: { onUtterance: (w: unknown) => Promise<void> }) => {
      utter = onUtterance;
      return {
        pause: () => calls.pause++,
        resume: () => calls.resume++,
        stop: () => calls.stop++,
      };
    },
    transcribe: async () => "hello there",
    sendTurn: async () => {},
    speakDone: () => Promise.resolve(),
    isBusy: () => false,
    interruptTurn: () => calls.interruptTurn++,
    onState: (s: string) => states.push(s),
    onError: () => {},
    guardMs: 1,
    delay: () => Promise.resolve(),
    ...overrides,
  });
  return { loop, calls, states, utter: () => utter! };
}

describe("the voice loop", () => {
  test("the happy cycle walks every state and re-listens", async () => {
    const { loop, states, calls, utter } = await build();
    await loop.start();
    await utter()("wav");
    assert.deepEqual(states, [
      "listening",
      "transcribing",
      "thinking",
      "speaking",
      "listening",
    ]);
    assert.equal(calls.pause, 1, "mic paused the moment the utterance completed");
    assert.equal(calls.resume, 2, "armed on start and re-armed after speaking");
  });

  test("silence keeps listening and never starts a turn", async () => {
    let turns = 0;
    const { loop, states, utter } = await build({
      transcribe: async () => "   ",
      sendTurn: async () => {
        turns++;
      },
    });
    await loop.start();
    await utter()("wav");
    assert.equal(turns, 0);
    assert.deepEqual(states.at(-1), "listening");
  });

  test("a turn the user typed mid-transcription supersedes the utterance", async () => {
    let turns = 0;
    const { loop, utter, states } = await build({
      isBusy: () => true,
      sendTurn: async () => {
        turns++;
      },
    });
    await loop.start();
    await utter()("wav");
    assert.equal(turns, 0, "the voiced words are dropped, not queued");
    assert.equal(states.at(-1), "listening");
  });

  test("interrupt during thinking aborts once and a late resolution is ignored", async () => {
    let releaseTurn: () => void = () => {};
    const { loop, calls, states, utter } = await build({
      sendTurn: () => new Promise<void>((r) => (releaseTurn = r)),
    });
    await loop.start();
    const cycle = utter()("wav");
    await tick();
    assert.equal(loop.state, "thinking");

    loop.interrupt();
    assert.equal(calls.interruptTurn, 1);
    assert.equal(loop.state, "listening");

    releaseTurn(); // the aborted turn's promise settles late
    await cycle;
    assert.equal(loop.state, "listening", "stale continuation abandoned");
    assert.ok(!states.slice(states.indexOf("listening", 1)).includes("speaking"));
  });

  test("a speakDone that never settles cannot wedge the machine", async () => {
    const { loop, states, utter } = await build({
      speakDone: () => new Promise(() => {}), // the leak W-0 fixed, simulated anyway
    });
    await loop.start();
    const cycle = utter()("wav");
    await tick();
    assert.equal(loop.state, "speaking");

    loop.interrupt();
    assert.equal(loop.state, "listening", "epoch fence rescued the loop");
    void cycle;
    void states;
  });

  test("stop() from every state tears down exactly once", async () => {
    for (const arrangeState of ["listening", "transcribing", "thinking", "speaking"]) {
      let releaseTurn: () => void = () => {};
      const { loop, calls, utter } = await build({
        transcribe:
          arrangeState === "transcribing"
            ? () => new Promise(() => {})
            : async () => "words",
        sendTurn:
          arrangeState === "thinking"
            ? () => new Promise<void>((r) => (releaseTurn = r))
            : async () => {},
        speakDone:
          arrangeState === "speaking" ? () => new Promise(() => {}) : () => Promise.resolve(),
      });
      await loop.start();
      if (arrangeState !== "listening") {
        void utter()("wav");
        await tick();
      }
      assert.equal(loop.state, arrangeState, `arranged ${arrangeState}`);
      loop.stop();
      assert.equal(loop.state, "idle");
      assert.equal(calls.stop, 1, `recorder released from ${arrangeState}`);
      releaseTurn();
    }
  });

  test("held pauses for a typed turn and re-listens after its speech", async () => {
    const { loop, calls, states } = await build();
    await loop.start();
    loop.setHeld(true);
    assert.equal(loop.state, "held");
    assert.equal(calls.pause, 1);

    loop.setHeld(false);
    await tick();
    await tick();
    assert.equal(loop.state, "listening");
    assert.deepEqual(states, ["listening", "held", "speaking", "listening"]);
  });

  test("a recorder that cannot start reports and stays idle", async () => {
    let reported: unknown = null;
    const { loop } = await build({
      startRecorder: async () => {
        throw new Error("no microphone");
      },
      onError: (e: unknown) => (reported = e),
    });
    await loop.start();
    assert.equal(loop.state, "idle");
    assert.match(String((reported as Error)?.message), /no microphone/);
  });

  test("the guard delay uses the injected clock", async () => {
    const delays: number[] = [];
    const { loop, utter } = await build({
      guardMs: 123,
      delay: (ms: number) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    await loop.start();
    await utter()("wav");
    assert.deepEqual(delays, [123]);
  });
});
