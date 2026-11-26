import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The speech client against a fake worker thread. What breaks quietly here:
 * replies landing on the wrong request, and a dead worker leaving a caller
 * -- and the button above it -- waiting forever.
 */
const scratch = mkdtempSync(join(tmpdir(), "enio-voice-"));
process.env.ENIO_DATA_DIR = scratch;
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "mcp.json");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");

const { createVoiceClient } = await import("./voice.js");

class FakeWorker extends EventEmitter {
  sent: any[] = [];
  // Node's ref()/unref() are flags, not counts; the fake keeps the same shape.
  held = false;
  postMessage(msg: any) {
    this.sent.push(msg);
  }
  ref() {
    this.held = true;
  }
  unref() {
    this.held = false;
  }
  terminate() {
    this.emit("exit", 0);
  }
  reply(r: any) {
    this.emit("message", r);
  }
}

const deps = (spawn: () => FakeWorker) => ({
  spawn,
  engine: () => "kokoro",
  voice: () => "am_fenrir",
  model: () => "test-model",
});

const bytes = (b: Buffer | null) => (b ? [...b] : null);

test("replies are matched to requests by id, whatever order they arrive in", async () => {
  const w = new FakeWorker();
  const client = createVoiceClient(deps(() => w));
  const first = client.synthesize("First.");
  const second = client.synthesize("Second.");
  assert.equal(w.sent.length, 2);
  assert.equal(w.sent[0].op, "speak");
  assert.equal(w.sent[0].text, "First.");
  assert.equal(w.sent[0].voice, "am_fenrir");
  assert.equal(w.sent[0].model, "test-model");
  w.reply({ id: w.sent[1].id, ok: true, wav: new Uint8Array([2]).buffer });
  w.reply({ id: w.sent[0].id, ok: true, wav: new Uint8Array([1]).buffer });
  assert.deepEqual(bytes(await first), [1]);
  assert.deepEqual(bytes(await second), [2]);
  // Idle again: nothing owed, so the worker no longer holds the process open.
  assert.equal(w.held, false);
});

test("a worker that dies settles everyone waiting with null, and the next call starts a fresh one", async () => {
  const spawned: FakeWorker[] = [];
  const client = createVoiceClient(
    deps(() => {
      const w = new FakeWorker();
      spawned.push(w);
      return w;
    }),
  );
  const owed = client.synthesize("Hello.");
  spawned[0]!.emit("exit", 1);
  assert.equal(await owed, null);
  const again = client.synthesize("Again.");
  assert.equal(spawned.length, 2);
  spawned[1]!.reply({ id: spawned[1]!.sent[0].id, ok: true, wav: new Uint8Array([7]).buffer });
  assert.deepEqual(bytes(await again), [7]);
});

test("the engine switch is honoured without starting a worker", async () => {
  let spawns = 0;
  const client = createVoiceClient({
    spawn: () => {
      spawns += 1;
      return new FakeWorker();
    },
    engine: () => "off",
    voice: () => "v",
    model: () => "m",
  });
  assert.equal(await client.synthesize("Hi."), null);
  assert.equal(await client.warm(), false);
  assert.equal(spawns, 0);
});

test("warm reports the load, long text is capped, and a failed synthesis is null rather than a throw", async () => {
  const w = new FakeWorker();
  const client = createVoiceClient(deps(() => w));
  const warm = client.warm();
  assert.equal(w.sent[0].op, "warm");
  w.reply({ id: w.sent[0].id, ok: true });
  assert.equal(await warm, true);
  const spoken = client.synthesize("x".repeat(2000));
  assert.equal(w.sent[1].text.length, 1200);
  w.reply({ id: w.sent[1].id, ok: false, error: "no such voice" });
  assert.equal(await spoken, null);
  const voices = client.voices();
  w.reply({ id: w.sent[2].id, ok: true, voices: ["am_fenrir", "af_heart"] });
  assert.deepEqual(await voices, ["am_fenrir", "af_heart"]);
});

/**
 * The silence at a clip's ends. Kokoro leaves about 240 ms before the first
 * word and half a second after the last, and a reply is one clip per
 * sentence, so untrimmed there was three quarters of a second of nothing
 * between every two sentences. Nothing fails when the trim is wrong: the
 * voice just loses the start of its first word, or pauses like it forgot.
 */
function wavOf(samples: number[], { rate = 24000, float = true } = {}): Buffer {
  const bytes = float ? 4 : 2;
  const data = Buffer.alloc(samples.length * bytes);
  samples.forEach((v, i) => (float ? data.writeFloatLE(v, i * 4) : data.writeInt16LE(Math.round(v * 32767), i * 2)));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8, "latin1");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(float ? 3 : 1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * bytes, 28);
  head.writeUInt16LE(bytes, 32);
  head.writeUInt16LE(bytes * 8, 34);
  head.write("data", 36, "latin1");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const ms = (n: number, rate = 24000) => Math.round((n / 1000) * rate);
const framesOf = (wav: Buffer, bytes = 4) => wav.readUInt32LE(40) / bytes;

test("a clip keeps a short lead and tail, and loses the long silence around them", async () => {
  const { trimSilence, KEEP_LEAD_MS, KEEP_TAIL_MS } = await import("./voice.js");
  // 240 ms of floor, 500 ms of speech with a pause in the middle, 600 ms of floor.
  const speech = [...Array(ms(200)).fill(0.3), ...Array(ms(100)).fill(0), ...Array(ms(200)).fill(-0.3)];
  const clip = wavOf([...Array(ms(240)).fill(0.001), ...speech, ...Array(ms(600)).fill(0.001)]);
  const out = trimSilence(clip);

  assert.equal(framesOf(out), ms(KEEP_LEAD_MS) + speech.length + ms(KEEP_TAIL_MS));
  // The header agrees with the body, or a player reads past the end.
  assert.equal(out.readUInt32LE(4), out.length - 8);
  assert.equal(out.length, 44 + framesOf(out) * 4);
  // The first sample of speech is exactly where the lead says, untouched,
  // and the pause inside the sentence is still a pause.
  assert.ok(Math.abs(out.readFloatLE(44 + ms(KEEP_LEAD_MS) * 4) - 0.3) < 1e-6);
  assert.equal(out.readFloatLE(44 + (ms(KEEP_LEAD_MS) + ms(250)) * 4), 0);
});

test("a soft first consonant is speech, not silence to cut", async () => {
  const { trimSilence, KEEP_LEAD_MS } = await import("./voice.js");
  // An "h": quiet, well under the vowel that follows, and the first thing lost
  // by a trim that looks for loudness.
  const clip = wavOf([...Array(ms(300)).fill(0.0005), ...Array(ms(60)).fill(0.012), ...Array(ms(300)).fill(0.4), ...Array(ms(400)).fill(0)]);
  const out = trimSilence(clip);
  assert.ok(Math.abs(out.readFloatLE(44 + ms(KEEP_LEAD_MS) * 4) - 0.012) < 1e-6, "the consonant starts the clip");
});

test("16-bit clips are trimmed the same way", async () => {
  const { trimSilence, KEEP_LEAD_MS, KEEP_TAIL_MS } = await import("./voice.js");
  const clip = wavOf([...Array(ms(240, 16000)).fill(0), ...Array(ms(300, 16000)).fill(0.5), ...Array(ms(500, 16000)).fill(0)], { rate: 16000, float: false });
  const out = trimSilence(clip);
  assert.equal(framesOf(out, 2), ms(KEEP_LEAD_MS, 16000) + ms(300, 16000) + ms(KEEP_TAIL_MS, 16000));
});

test("what it cannot read, or has nothing to cut from, comes back as it was", async () => {
  const { trimSilence } = await import("./voice.js");
  const silent = wavOf(Array(ms(500)).fill(0));
  assert.equal(trimSilence(silent), silent, "silence throughout");
  const tight = wavOf(Array(ms(300)).fill(0.3));
  assert.equal(trimSilence(tight), tight, "already tight");
  const junk = Buffer.from("not a wav file at all, just some bytes that are long enough");
  assert.equal(trimSilence(junk), junk);
  const eightBit = wavOf(Array(ms(300)).fill(0.3));
  eightBit.writeUInt16LE(8, 34);
  assert.equal(trimSilence(eightBit), eightBit, "a format it does not know");
});
