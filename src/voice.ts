import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Worker } from "node:worker_threads";
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
 * Kokoro, loaded once and kept -- on its own thread.
 *
 * ~90MB at q8 and it stays resident, unlike the vision and dictation models
 * which are spawned per use. Speech is the one that would be noticed: a reply
 * arriving three seconds before it can be spoken is worse than the memory it
 * saves, and 90MB next to Maple's 6.9GB is not the thing worth reclaiming.
 *
 * A worker thread rather than this thread, because kokoro-js synthesises
 * synchronously and a sentence held the server's event loop for the length
 * of the clip: nothing answered while a reply was being read aloud, and the
 * launcher's health probe took the silence for a crash (see voice-worker.ts).
 * A thread rather than a child process: kokoro is JavaScript already in this
 * process's dependency tree, and a thread hands the WAV back by transfer.
 *
 * Replies are matched to requests by id, and a worker that dies settles every
 * caller still waiting -- the transcription worker's rule, for the same
 * reason: a promise nobody will ever resolve is a button stuck on "speaking".
 */
export interface VoiceWorkerLike {
  postMessage(msg: unknown): void;
  on(event: string, fn: (...args: any[]) => void): unknown;
  ref(): void;
  unref(): void;
  terminate(): unknown;
}

interface VoiceReply {
  id: number;
  ok: boolean;
  wav?: ArrayBuffer;
  voices?: string[];
  error?: string;
}

export interface VoiceClient {
  warm(): Promise<boolean>;
  synthesize(text: string): Promise<Buffer | null>;
  voices(): Promise<string[]>;
  stop(): void;
}

export function createVoiceClient(deps: {
  spawn: () => VoiceWorkerLike;
  engine: () => string;
  voice: () => string;
  model: () => string;
}): VoiceClient {
  let worker: VoiceWorkerLike | null = null;
  let nextId = 1;
  const pending = new Map<number, (reply: VoiceReply) => void>();

  const settleAll = (error: string): void => {
    for (const [id, resolve] of pending) resolve({ id, ok: false, error });
    pending.clear();
  };
  // Referenced only while something is owed: an idle worker must not hold a
  // one-shot CLI (enio voice --voices) open after it has printed.
  const idle = (): void => {
    if (pending.size === 0) worker?.unref();
  };

  const ensure = (): VoiceWorkerLike => {
    if (worker) return worker;
    const w = deps.spawn();
    worker = w;
    w.on("message", (reply: VoiceReply) => {
      const resolve = pending.get(reply.id);
      if (!resolve) return;
      pending.delete(reply.id);
      resolve(reply);
      idle();
    });
    const gone = (why: string): void => {
      if (worker === w) worker = null;
      settleAll(why);
    };
    w.on("error", (err: Error) => gone(err?.message ?? "voice worker failed"));
    w.on("exit", (code: number) => gone(`voice worker stopped (code ${code})`));
    return w;
  };

  const request = (msg: { op: "warm" | "voices" | "speak"; text?: string; voice?: string }): Promise<VoiceReply> =>
    new Promise((resolve) => {
      const id = nextId++;
      try {
        const w = ensure();
        pending.set(id, resolve);
        w.ref();
        w.postMessage({ id, model: deps.model(), ...msg });
      } catch (err) {
        pending.delete(id);
        resolve({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });

  return {
    /**
     * Load the voice model without speaking anything.
     *
     * Kokoro loads on first use, which put roughly four and a half seconds in
     * front of the first spoken sentence of a session -- heard as the
     * assistant sitting silent after the answer was already on screen. The
     * desktop calls this when speech is switched on, so the wait happens while
     * the user is reading rather than while they are waiting to be read to.
     * Safe to call repeatedly: the worker loads once and answers every call
     * after the first from the same load.
     */
    async warm(): Promise<boolean> {
      if (deps.engine() !== "kokoro") return false;
      return (await request({ op: "warm" })).ok;
    },
    /**
     * Text to a WAV buffer, or null if synthesis is unavailable.
     *
     * Null rather than throwing: a reply that cannot be spoken has still been
     * read, and the caller's job is to fall back quietly, not to surface a
     * failure about a feature that is decoration.
     */
    async synthesize(text: string): Promise<Buffer | null> {
      const trimmed = text.trim();
      if (!trimmed || deps.engine() === "off") return null;
      // Capped because the first sentence is what anyone actually listens to,
      // and synthesising four paragraphs nobody waits for costs real seconds.
      const reply = await request({ op: "speak", text: trimmed.slice(0, 1200), voice: deps.voice() });
      return reply.ok && reply.wav ? Buffer.from(reply.wav) : null;
    },
    /** Which voices this build can speak in. */
    async voices(): Promise<string[]> {
      const reply = await request({ op: "voices" });
      return reply.ok ? (reply.voices ?? []) : [];
    },
    stop(): void {
      const w = worker;
      worker = null;
      settleAll("voice worker stopped");
      try {
        void w?.terminate();
      } catch {
        // Already gone.
      }
    },
  };
}

const voiceClient = createVoiceClient({
  // Next to this file in dist/, which is what runs; tests inject a fake.
  spawn: () => new Worker(new URL("./voice-worker.js", import.meta.url)),
  engine: () => config.ttsEngine,
  voice: () => config.kokoroVoice,
  model: () => config.kokoroModel,
});

export const warmVoice = (): Promise<boolean> => voiceClient.warm();
export const synthesize = (text: string): Promise<Buffer | null> => voiceClient.synthesize(text);
export const kokoroVoices = (): Promise<string[]> => voiceClient.voices();

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
