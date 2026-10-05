
/**
 * Kokoro, in a process of its own.
 *
 * kokoro-js synthesises on the thread that calls it: the phonemiser and the
 * ONNX run are synchronous JavaScript and WebAssembly, and a sentence holds
 * that thread for about as long as the clip lasts -- 8.5 seconds measured for
 * two long sentences at once. On the server's thread that meant no /ping, no
 * chat and no transcription while a reply was being read aloud, and the
 * launcher's two-second probe declared the agent dead each time, flipping the
 * window to "Could not start" mid-sentence.
 *
 * A process, not a worker thread: the first version was a worker, and the
 * agent aborted seven minutes in, on its main thread, inside onnxruntime's
 * binding. The embedding model loads the same native addon on the main
 * isolate, and the addon keeps per-process statics (its class constructors
 * among them), so the second isolate to load it owns those references and
 * the first crashes the moment it builds a tensor -- SIGABRT in
 * OrtValueToNapiValue, no JavaScript error to catch. Two isolates cannot
 * share onnxruntime-node; two processes can. The protocol is unchanged:
 * one message in, one out, matched by id, over the fork's IPC channel with
 * advanced serialization so the WAV crosses as bytes, not base64.
 */
interface Request {
  id: number;
  op: "warm" | "voices" | "speak";
  model: string;
  text?: string;
  voice?: string;
}

if (typeof process.send !== "function") throw new Error("voice-worker.js runs as a forked child, not a script");
const port = {
  postMessage(msg: object): void {
    process.send!(msg);
  },
};

// ~90MB at q8 and kept resident: a reply arriving seconds before it can be
// spoken is worse than the memory, and the thread is where that memory lives.
let tts: Promise<any> | null = null;

function load(model: string): Promise<any> {
  if (!tts) {
    tts = (async () => {
      const { KokoroTTS } = await import("kokoro-js");
      return KokoroTTS.from_pretrained(model, { dtype: "q8", device: "cpu" });
    })();
  }
  return tts;
}

/** The bytes as a view the IPC channel serialises whole. */
function detached(wav: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (wav instanceof ArrayBuffer) return new Uint8Array(wav);
  return new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength);
}

process.on("message", async (msg: Request) => {
  try {
    const engine = await load(msg.model);
    if (msg.op === "warm") {
      port.postMessage({ id: msg.id, ok: true });
      return;
    }
    if (msg.op === "voices") {
      port.postMessage({ id: msg.id, ok: true, voices: Object.keys(engine.voices) });
      return;
    }
    const audio = await engine.generate(msg.text ?? "", { voice: msg.voice });
    const wav = detached(audio.toWav());
    port.postMessage({ id: msg.id, ok: true, wav });
  } catch (err) {
    // No model, no network on first run, or an unknown voice name. Forgotten
    // rather than kept, so the next request loads again instead of failing
    // on a promise that already rejected.
    tts = null;
    port.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
