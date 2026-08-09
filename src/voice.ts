import { spawn } from "node:child_process";
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
export async function transcribeWav(path: string): Promise<Transcription> {
  if (!whisperInstalled()) {
    return { text: "", error: "speech recognition is not installed" };
  }

  const script = join(projectRoot, "scripts", "transcribe.py");
  const child = spawn(venvPython(), [script, path, config.voiceModel], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));

  const code: number = await new Promise((resolve) => {
    child.on("error", () => resolve(1));
    child.on("exit", (c) => resolve(c ?? 1));
  });

  // The last line, not the whole stream: mlx-whisper writes "Detected
  // language" and a progress bar to stdout regardless of verbose=False, so
  // parsing everything fails on output that is perfectly fine.
  const lastLine =
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .pop() ?? "";

  try {
    const parsed = JSON.parse(lastLine) as Transcription;
    if (parsed.error) return { text: "", error: parsed.error };
    return { text: parsed.text ?? "" };
  } catch {
    // stderr carries the model download progress bars, so it is only worth
    // reporting when there is no parseable result at all.
    return {
      text: "",
      error: code === 0 ? "no transcription returned" : err.trim().split("\n").pop() || "failed",
    };
  }
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
