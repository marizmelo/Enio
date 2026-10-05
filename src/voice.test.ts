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
