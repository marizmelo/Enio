import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Which model the machine runs, as a setting rather than a launch flag.
 *
 * The first attempt at running a second model was ENIO_MODEL at launch, and
 * it fell apart on the restart cycle: quitting the app shuts down the model
 * server it was using, and the relaunch — which does not inherit a shell's
 * env — could only ever bring Maple back. A model choice has to outlive the
 * process that made it, which means it is persisted state, not environment.
 *
 * Machine-wide, next to the client registry, for the same reason the registry
 * lives there: there is one model server per machine, so the choice of what
 * it serves cannot be per-data-directory either.
 *
 * The env var still wins when present. It is how a one-off experiment or a
 * test points elsewhere without changing what the machine boots tomorrow.
 */

const SETTING_FILE = "model.json";

/** The sentinel for the bundled default; anything else is an HF model id. */
export const MAPLE = "maple";

export function currentModelId(): string {
  const env = process.env.ENIO_MODEL ?? process.env.MAPLE_MODEL;
  if (env?.trim()) return env.trim();
  try {
    const raw = readFileSync(join(config.machineStateDir, SETTING_FILE), "utf8");
    const parsed = JSON.parse(raw) as { model?: string };
    if (typeof parsed.model === "string" && parsed.model.trim()) return parsed.model.trim();
  } catch {
    /* No setting yet: the default. */
  }
  return MAPLE;
}

export function setModelId(id: string): void {
  writeFileSync(
    join(config.machineStateDir, SETTING_FILE),
    JSON.stringify({ model: id.trim() }, null, 2) + "\n",
  );
}

/**
 * The models this machine can actually serve: the bundled default, plus any
 * MLX model already in the Hugging Face cache. A closed list, scanned rather
 * than typed, because a model id with a typo in it is ninety seconds of
 * loading followed by a download of several gigabytes nobody asked for --
 * switching is choosing from what is present, and downloading is a decision
 * made elsewhere, deliberately.
 */
export function availableModels(): string[] {
  const models = [MAPLE];
  const hub = join(homedir(), ".cache", "huggingface", "hub");
  try {
    if (existsSync(hub)) {
      for (const entry of readdirSync(hub)) {
        // Cache directories are named models--org--repo.
        const match = /^models--(.+?)--(.+)$/.exec(entry);
        if (!match) continue;
        const id = `${match[1]}/${match[2]}`;
        // Only chat models the mlx_lm runtime can load. The cache also holds
        // vision models (their own server), speech models (whisper, TTS
        // voices) and embeddings -- offering one of those is offering a
        // ninety-second failed load. Maple's own cache entry is skipped too:
        // the bundled default already represents those weights, and the same
        // model twice under two names is a choice with no difference in it.
        // A blocklist, not a guarantee: the switch reverts on a failed start,
        // which is the real safety net.
        if (
          /mlx/i.test(id) &&
          !/-VL-|vision|whisper|kokoro|tts|speech|embed|rerank|maple/i.test(id)
        ) {
          models.push(id);
        }
      }
    }
  } catch {
    /* An unreadable cache means the bundled default is the whole list. */
  }
  return models;
}

/** What request bodies should name. The bundled default keeps its API id;
 *  anything else is addressed by its own id. */
export function requestModelName(): string {
  const id = currentModelId();
  return id === MAPLE ? config.modelName : id;
}

/** The --model argument for whatever is chosen: the bundled weights directory
 *  for the default, the HF id (resolved from the local cache) otherwise.
 *  Shared by every path that spawns the server -- `enio up` had its own spawn
 *  with the Maple path written out, and quietly ignored the setting. */
export function currentModelPath(): string {
  const id = currentModelId();
  return id === MAPLE ? join(config.runtimeDir, "maple-2bit-mlx") : id;
}

export function currentModelLabel(): string {
  const id = currentModelId();
  return id === MAPLE ? "Maple" : id;
}
