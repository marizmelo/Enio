import { parentPort } from "node:worker_threads";

/**
 * Kokoro, on a thread of its own.
 *
 * kokoro-js synthesises on the thread that calls it: the phonemiser and the
 * ONNX run are synchronous JavaScript and WebAssembly, and a sentence holds
 * that thread for about as long as the clip lasts -- 8.5 seconds measured for
 * two long sentences at once. On the server's thread that meant no /ping, no
 * chat and no transcription while a reply was being read aloud, and the
 * launcher's two-second probe declared the agent dead each time, flipping the
 * window to "Could not start" mid-sentence. Here the only thing a sentence
 * holds up is the next sentence.
 *
 * One message in, one message out, matched by id. The WAV goes back as a
 * transferred ArrayBuffer rather than a structured-clone copy.
 */
interface Request {
  id: number;
  op: "warm" | "voices" | "speak";
  model: string;
  text?: string;
  voice?: string;
}

const port = parentPort;
if (!port) throw new Error("voice-worker.js runs as a worker thread, not a script");

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

/** A buffer nobody else references, so it can be transferred rather than copied. */
function detached(wav: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (wav instanceof ArrayBuffer) return wav;
  return new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength).slice().buffer as ArrayBuffer;
}

port.on("message", async (msg: Request) => {
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
    port.postMessage({ id: msg.id, ok: true, wav }, [wav]);
  } catch (err) {
    // No model, no network on first run, or an unknown voice name. Forgotten
    // rather than kept, so the next request loads again instead of failing
    // on a promise that already rejected.
    tts = null;
    port.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
