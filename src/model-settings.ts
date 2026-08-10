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

/**
 * How much conversation the *currently selected* model can still recall.
 *
 * Not the model's advertised context length, which is a different and much
 * larger number. This is the band where a planted fact is still answered
 * correctly -- for Maple that was measured at 4/4 correct around 1.5k tokens
 * and 0/4 by 12k, which is where the 2000 default came from. Filling a
 * declared 128k window would not error; it would quietly stop remembering,
 * and that failure is invisible from the outside.
 *
 * It has to be a function rather than a constant on config, because the model
 * is switchable at runtime: a constant read at import would keep Maple's
 * budget after switching to something with far more room, and -- worse -- keep
 * a larger budget after switching back to Maple, which degrades answers
 * silently.
 *
 * Lives here rather than in config because resolving it needs the current
 * model, and config cannot import this module without a cycle.
 */
const MEASURED_BUDGETS: Array<[pattern: RegExp, tokens: number, measured: boolean]> = [
  // Measured in this project: recall falls off hard past ~2k.
  [/^maple$|maple/i, 2000, true],
  // Dense models with real long-context training hold far more than Maple's
  // 1B active does. NOT measured here -- a conservative step up rather than
  // the 256k these advertise, and it should be replaced with a number from
  // the same planted-fact test that produced Maple's.
  [/qwen3/i, 12000, false],
];

const DEFAULT_BUDGET = 8000;

export function contextBudget(): number {
  const env = process.env.ENIO_CONTEXT_BUDGET ?? process.env.MAPLE_CONTEXT_BUDGET;
  const override = Number(env);
  if (env != null && Number.isFinite(override) && override > 0) return override;

  const id = currentModelId();
  for (const [pattern, tokens] of MEASURED_BUDGETS) {
    if (pattern.test(id)) return tokens;
  }
  return DEFAULT_BUDGET;
}

/** Whether the current model's budget came from a measurement or a guess.
 *  Surfaced so a client can say so rather than implying more confidence than
 *  there is. */
export function contextBudgetMeasured(): boolean {
  const id = currentModelId();
  for (const [pattern, , measured] of MEASURED_BUDGETS) {
    if (pattern.test(id)) return measured;
  }
  return false;
}
