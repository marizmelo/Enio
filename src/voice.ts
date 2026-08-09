import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config, projectRoot } from "./config.js";

/**
 * Speech in and speech out, both local.
 *
 * Two different tools on purpose, rather than one stack that does both:
 *
 *   in   mlx-whisper — same MLX runtime as the chat and vision models, and a
 *        dedicated package rather than mlx-vlm's audio queue, which returns
 *        200 with no audio for speech and hangs on transcription in 0.6.10.
 *   out  macOS `say` — already on the machine, offline, instant, and needs no
 *        model at all. A neural voice sounds better and can replace this the
 *        day the mlx-audio path works; until then, shipping something that
 *        speaks beats shipping something that would.
 *
 * Both degrade to nothing rather than failing: no whisper install means the
 * microphone button is withheld, and no `say` means replies stay silent.
 */

/** Whisper runs in the vision venv — same isolation, same reasoning. */
function venvPython(): string {
  return join(config.visionVenvDir, "bin", "python");
}

export function whisperInstalled(): boolean {
  return existsSync(venvPython());
}

export interface Transcription {
  text: string;
  error?: string;
}

/**
 * Transcribe a 16kHz mono WAV.
 *
 * Spawned rather than kept resident: dictation is bursty, the model is ~500MB,
 * and holding it between utterances would compete with the chat model for
 * exactly the memory this project spends so much effort not wasting.
 */
/**
 * The resident worker, and a FIFO of who is waiting for what.
 *
 * Starting Python and importing mlx_whisper costs about a second, which live
 * dictation was paying on every pass -- most of the delay between speaking and
 * seeing words. One process pays it once and keeps the weights loaded.
 *
 * Responses are matched to requests by order, which is safe because the worker
 * reads one line and answers one line before reading the next. The first
 * attempt at this attached a listener per request and read up to the first
 * newline; when two responses arrived in one chunk the second was discarded,
 * and every answer after that belonged to the previous question. One reader
 * that owns the buffer is the only version of this that stays in step.
 */
let worker: ChildProcessWithoutNullStreams | null = null;
let workerReady: Promise<void> | null = null;
const pending: ((result: Transcription) => void)[] = [];

function settleAll(result: Transcription): void {
  while (pending.length > 0) pending.shift()!(result);
}

function startWorker(): Promise<void> {
  if (workerReady) return workerReady;

  workerReady = new Promise<void>((resolve, reject) => {
    const script = join(projectRoot, "scripts", "transcribe_worker.py");
    const child = spawn(venvPython(), [script], { stdio: ["pipe", "pipe", "pipe"] });
    worker = child;

    let buffer = "";
    let ready = false;

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();

      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let parsed: { ready?: boolean; text?: string; error?: string };
        try {
          parsed = JSON.parse(line);
        } catch {
          pending.shift()?.({ text: "", error: "unreadable worker response" });
          continue;
        }

        if (!ready && parsed.ready) {
          ready = true;
          resolve();
          continue;
        }

        pending.shift()?.(
          parsed.error ? { text: "", error: parsed.error } : { text: parsed.text ?? "" },
        );
      }
    });

    // A dead worker must not leave callers waiting on a promise that will never
    // settle. Everyone in the queue is told, and the next call starts a fresh
    // process.
    child.on("exit", () => {
      worker = null;
      workerReady = null;
      settleAll({ text: "", error: "transcription worker stopped" });
      if (!ready) reject(new Error("worker exited before it was ready"));
    });

    child.on("error", (err) => {
      worker = null;
      workerReady = null;
      settleAll({ text: "", error: err.message });
      reject(err);
    });
  });

  return workerReady;
}

async function ask(path: string, model: string): Promise<Transcription> {
  try {
    await startWorker();
  } catch (err) {
    return { text: "", error: (err as Error).message };
  }

  const child = worker;
  if (!child) return { text: "", error: "worker unavailable" };

  return new Promise<Transcription>((resolve) => {
    pending.push(resolve);
    child.stdin.write(`${JSON.stringify({ path, model })}\n`);
  });
}

/**
 * Transcribe a 16kHz mono WAV.
 *
 * Spawned rather than kept resident: dictation is bursty, the model is ~500MB,
 * and holding it between utterances would compete with the chat model for
 * exactly the memory this project spends so much effort not wasting.
 */
/**
 * Transcribe a 16kHz mono WAV.
 *
 * `fast` picks the smaller model, for the interim passes during live dictation
 * where being a second behind matters more than a perfect noun. The final pass
 * uses the accurate one, so what gets sent is what the better model heard.
 */
export async function transcribeWav(
  path: string,
  opts: { fast?: boolean } = {},
): Promise<Transcription> {
  if (!whisperInstalled()) {
    return { text: "", error: "speech recognition is not installed" };
  }
  return ask(path, opts.fast ? config.voiceModelFast : config.voiceModel);
}

/**
 * Kokoro, loaded once and kept.
 *
 * ~90MB at q8 and it stays resident, unlike the vision and dictation models
 * which are spawned per use. Speech is the one that would be noticed: a reply
 * arriving three seconds before it can be spoken is worse than the memory it
 * saves, and 90MB next to Maple's 6.9GB is not the thing worth reclaiming.
 */
let kokoro: Promise<any> | null = null;

async function loadKokoro(): Promise<any> {
  if (!kokoro) {
    kokoro = (async () => {
      const { KokoroTTS } = await import("kokoro-js");
      return KokoroTTS.from_pretrained(config.kokoroModel, {
        dtype: "q8",
        device: "cpu",
      });
    })();
  }
  return kokoro;
}

/**
 * Text to a WAV buffer, or null if synthesis is unavailable.
 *
 * Null rather than throwing: a reply that cannot be spoken has still been
 * read, and the caller's job is to fall back quietly, not to surface a failure
 * about a feature that is decoration.
 */
export async function synthesize(text: string): Promise<Buffer | null> {
  const trimmed = text.trim();
  if (!trimmed || config.ttsEngine === "off") return null;

  try {
    const tts = await loadKokoro();
    // Capped because the first sentence is what anyone actually listens to,
    // and synthesising four paragraphs nobody waits for costs real seconds.
    const audio = await tts.generate(trimmed.slice(0, 1200), {
      voice: config.kokoroVoice,
    });
    return Buffer.from(audio.toWav());
  } catch {
    // No model, no network on first run, or an unknown voice name. The system
    // voice still works and needs nothing.
    kokoro = null;
    return null;
  }
}

/** Which voices this build can speak in. */
export async function kokoroVoices(): Promise<string[]> {
  try {
    const tts = await loadKokoro();
    return Object.keys(tts.voices);
  } catch {
    return [];
  }
}

/**
 * Speak text aloud through the system voice.
 *
 * Fire and forget, and deliberately not awaited by the turn: a reply that has
 * already been read on screen must not be held up by finishing the sentence
 * out loud.
 */
export function speak(text: string): void {
  if (process.platform !== "darwin") return;

  const trimmed = text.trim();
  if (!trimmed) return;

  // Passed as an argument rather than through a shell, so nothing in a model's
  // reply can be interpreted as a command.
  const args = config.voiceName ? ["-v", config.voiceName] : [];
  const child = spawn("say", [...args, "--", trimmed.slice(0, 2000)], { stdio: "ignore" });
  child.on("error", () => {
    /* No `say` on this machine. Silence is the correct degradation. */
  });
  child.unref();
}
