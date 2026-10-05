import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * The speech sink that routes sentences through the face. The contract the
 * player relies on: reject only before anything is queued, resolve when the
 * clip has been said, and settle on stop() yourself -- the library drops
 * queued markers along with the audio.
 */
const LIB = "../desktop/renderer/src/lib/avatar-sink.js";
interface Sink {
  play(blob: unknown, text: string, timing?: unknown): Promise<void>;
  stop(): void;
  dispose(): void;
}
const { createAvatarSink } = (await import(LIB)) as {
  createAvatarSink: (head: unknown, opts?: { graceMs?: number }) => Sink;
};

function fakeHead() {
  const markers: Array<() => void> = [];
  const spoken: Array<{ u: Record<string, unknown>; opt: Record<string, unknown> }> = [];
  const head = {
    stops: 0,
    spoken,
    audioCtx: { decodeAudioData: async (buf: ArrayBuffer) => ({ duration: 1.2, length: buf.byteLength }) },
    speakAudio(u: Record<string, unknown>, opt: Record<string, unknown>) {
      spoken.push({ u, opt });
    },
    speakMarker(fn: () => void) {
      markers.push(fn);
    },
    // Like the library: the queue goes, markers included.
    stopSpeaking() {
      head.stops++;
      markers.length = 0;
    },
    fire() {
      for (const fn of markers.splice(0)) fn();
    },
  };
  return head;
}
const blob = { arrayBuffer: async () => new ArrayBuffer(16) };
const tick = () => new Promise((r) => setTimeout(r, 5));
const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => (done = true));
  await tick();
  return done;
};

describe("the avatar speech sink", () => {
  test("queues the clip with estimated word timings and resolves when the marker fires", async () => {
    const head = fakeHead();
    const sink = createAvatarSink(head);
    const p = sink.play(blob, "Hello there friend.");
    await tick();
    assert.equal(head.spoken.length, 1);
    const { u, opt } = head.spoken[0]!;
    assert.deepEqual(u.words, ["Hello", "there", "friend."]);
    assert.equal((u.wtimes as number[]).length, 3);
    assert.ok((u.wtimes as number[])[2]! + (u.wdurations as number[])[2]! <= 1200, "inside the 1.2s clip");
    assert.equal(opt.isRaw, true, "no 300ms break after every sentence");
    assert.equal(opt.lipsyncLang, "en");
    assert.equal(await settled(p), false, "not done until the head says so");
    head.fire();
    assert.equal(await settled(p), true);
  });

  test("stop() stops the head and settles a pending play", async () => {
    const head = fakeHead();
    const sink = createAvatarSink(head);
    const p = sink.play(blob, "A long sentence.");
    await tick();
    sink.stop();
    assert.equal(head.stops, 1);
    assert.equal(await settled(p), true, "would otherwise hang: the marker was dropped");
  });

  test("a clip that will not decode rejects before anything is queued", async () => {
    const head = fakeHead();
    head.audioCtx.decodeAudioData = async () => {
      throw new Error("not a wav");
    };
    const sink = createAvatarSink(head);
    await assert.rejects(sink.play(blob, "x"), /not a wav/);
    assert.equal(head.spoken.length, 0, "the player may now say it the plain way without a double");
  });

  test("real timings pass through untouched when the voice has them", async () => {
    const head = fakeHead();
    const sink = createAvatarSink(head);
    const timing = { words: ["x"], wtimes: [0], wdurations: [100], visemes: ["aa"], vtimes: [0], vdurations: [100] };
    const p = sink.play(blob, "x", timing);
    await tick();
    assert.deepEqual(head.spoken[0]!.u.visemes, ["aa"]);
    assert.deepEqual(head.spoken[0]!.u.wtimes, [0]);
    head.fire();
    await p;
  });

  test("dispose settles without touching the head", async () => {
    const head = fakeHead();
    const sink = createAvatarSink(head);
    const p = sink.play(blob, "Bye.");
    await tick();
    sink.dispose();
    assert.equal(await settled(p), true);
    assert.equal(head.stops, 0);
  });

  test("a decode still in flight when the sink is disposed does not hang the play", async () => {
    const head = fakeHead();
    // Chromium can leave decodeAudioData unsettled once its context closes.
    head.audioCtx.decodeAudioData = () => new Promise(() => {});
    const sink = createAvatarSink(head);
    const p = sink.play(blob, "Stuck.");
    await tick();
    sink.dispose();
    assert.equal(await settled(p), true);
    assert.equal(head.spoken.length, 0, "nothing was queued on a dead head");
  });

  test("a marker the head never fires is covered by the clip-length watchdog", async () => {
    const head = fakeHead();
    const sink = createAvatarSink(head, { graceMs: 20 });
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(String(args[0]));
    try {
      const p = sink.play(blob, "Lost marker.");
      await new Promise((r) => setTimeout(r, 1200 + 20 + 60));
      assert.equal(await settled(p), true);
      assert.match(warned.join("\n"), /without the head's marker/);
    } finally {
      console.warn = original;
    }
  });
});
