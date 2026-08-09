import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { serverIsUp } from "./model.js";
import { canRunMaple, isWindows, whyNoMaple } from "./platform.js";

/**
 * How the model server is launched, in one place because there are two callers
 * (`enio start` and the desktop backend) and a flag that only one of them
 * passes is a difference nobody notices until the two behave differently.
 *
 * The KV-cache byte cap is the load-bearing one. mlx-lm bounds the prompt
 * cache by *slot count* (ten) and, unless told otherwise, not by size at all --
 * `--prompt-cache-bytes` has no default. Ten slots is a fine bound when a slot
 * is a short chat and a bad one when it is a long thread: Maple's KV runs
 * 48KB per token, so ten 16k-token conversations is 7.3GB of cache on top of
 * roughly 5GB of weights. That fits on the 64GB machines these numbers usually
 * come from and does not fit here.
 *
 * How the cap is sized, and why, is in config.ts alongside the setting.
 */
export function modelServerArgs(modelPath: string): string[] {
  return [
    "-m", "mlx_lm.server",
    "--model", modelPath,
    "--trust-remote-code",
    "--flash-head",
    "--prompt-cache-bytes", `${config.promptCacheGb}G`,
    "--port", "8080",
  ];
}

/**
 * Bringing the configured backend up.
 *
 * One rule governs all of this: only stop what we started. A model server that
 * was already running belongs to someone else — Ollama in particular is usually
 * a shared system service, and killing it on exit would break whatever else was
 * using it.
 */

export interface RunningBackend {
  /** Stops the process only if this call is what started it. */
  stop(): void;
}

export interface EnsureOptions {
  log(message: string): void;
  /** Asked before a multi-gigabyte download. Non-interactive callers say no. */
  confirm(question: string): Promise<boolean>;
}

const NOOP: RunningBackend = { stop: () => {} };

export async function ensureBackend(opts: EnsureOptions): Promise<RunningBackend> {
  if (await serverIsUp()) {
    opts.log(`Using the ${config.backendId} server already running on ${config.modelBaseUrl}`);
    return NOOP;
  }

  switch (config.backendId) {
    case "maple":
      return startMaple(opts);
    case "ollama":
      return startOllama(opts);
    default:
      throw new Error(
        `enio can't start a ${config.backendId} server for you.\n` +
          `Start it yourself, then run 'enio chat'.\n` +
          `  lmstudio:  start the local server from the Developer tab\n` +
          `  llamacpp:  llama-server --jinja -m <model.gguf> --port 8081\n`,
      );
  }
}

/* ---------- maple ------------------------------------------------------- */

async function startMaple(opts: EnsureOptions): Promise<RunningBackend> {
  if (!canRunMaple()) {
    throw new Error(
      `${whyNoMaple()}\n\n` +
        `Everything else in enio works here. Switch backends:\n` +
        `    ENIO_BACKEND=ollama enio start\n`,
    );
  }

  const venvPython = join(config.runtimeDir, ".venv", "bin", "python");
  if (!existsSync(venvPython)) {
    throw new Error(
      `No model runtime found at ${config.runtimeDir}\n\n` +
        `Install it with:   bash install.sh\n` +
        `Point elsewhere:   ENIO_DIR=/path/to/runtime\n`,
    );
  }

  const logPath = join(config.dataDir, "model-server.log");
  const log = openSync(logPath, "a");

  const child = spawn(
    venvPython,
    modelServerArgs(join(config.runtimeDir, "maple-2bit-mlx")),
    { cwd: config.runtimeDir, stdio: ["ignore", log, log] },
  );

  await waitForServer(child, opts, 90, `Starting Maple — first load reads ~5GB`, logPath);
  return { stop: () => kill(child) };
}

/* ---------- ollama ------------------------------------------------------ */

/** Ollama's own API lives beside the OpenAI-compatible one, not under /v1. */
function ollamaRoot(): string {
  return config.modelBaseUrl.replace(/\/v1\/?$/, "");
}

function ollamaInstalled(): boolean {
  const probe = spawnSync(isWindows() ? "where" : "which", ["ollama"], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

async function startOllama(opts: EnsureOptions): Promise<RunningBackend> {
  if (!ollamaInstalled()) {
    throw new Error(
      `Ollama isn't installed.\n\n` +
        `  Install it:  https://ollama.com/download\n` +
        `  Then:        ollama pull ${config.modelName}\n`,
    );
  }

  const logPath = join(config.dataDir, "ollama.log");
  const log = openSync(logPath, "a");
  const child = spawn("ollama", ["serve"], { stdio: ["ignore", log, log] });

  await waitForServer(child, opts, 20, "Starting Ollama", logPath);
  await ensureModelPulled(opts);
  return { stop: () => kill(child) };
}

/**
 * A model that isn't pulled fails in a confusing way: the request 404s and it
 * reads like enio is broken. Checking up front turns that into one clear
 * prompt.
 */
async function ensureModelPulled(opts: EnsureOptions): Promise<void> {
  let tags: string[] = [];
  try {
    const res = await fetch(`${ollamaRoot()}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { models?: { name?: string }[] };
      tags = (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    }
  } catch {
    return; // Not fatal — let the actual request produce the error.
  }

  if (modelIsPulled(config.modelName, tags)) return;

  opts.log(`Model "${config.modelName}" isn't pulled yet.`);
  if (tags.length > 0) opts.log(`Available: ${tags.join(", ")}`);

  const ok = await opts.confirm(`Pull ${config.modelName} now? (several GB)`);
  if (!ok) {
    throw new Error(
      `Can't continue without the model.\n` +
        `  Pull it:      ollama pull ${config.modelName}\n` +
        `  Or use one you have:  ENIO_MODEL=<name> enio start\n`,
    );
  }

  // Inherit stdio so Ollama's own progress bar reaches the terminal — a silent
  // multi-gigabyte download looks like a hang.
  const pull = spawnSync("ollama", ["pull", config.modelName], { stdio: "inherit" });
  if (pull.status !== 0) throw new Error(`ollama pull ${config.modelName} failed.`);
}

/**
 * Ollama reports tags as "qwen3:8b" but accepts a bare "qwen3", which then
 * resolves to "qwen3:latest". Comparing strings exactly would demand a pull
 * that isn't needed.
 */
export function modelIsPulled(wanted: string, tags: string[]): boolean {
  const target = wanted.toLowerCase();
  const normalized = tags.map((t) => t.toLowerCase());
  if (normalized.includes(target)) return true;
  if (!target.includes(":")) {
    return normalized.some((t) => t.split(":")[0] === target);
  }
  return false;
}

/* ---------- shared ------------------------------------------------------ */

async function waitForServer(
  child: ReturnType<typeof spawn>,
  opts: EnsureOptions,
  seconds: number,
  message: string,
  logPath: string,
): Promise<void> {
  let exitedEarly = false;
  child.on("exit", () => { exitedEarly = true; });

  process.stdout.write(`\x1b[2m${message}\x1b[0m`);
  for (let i = 0; i < seconds && !exitedEarly; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (i % 2 === 0) process.stdout.write("\x1b[2m.\x1b[0m");
    if (await serverIsUp()) {
      process.stdout.write("\n");
      return;
    }
  }
  process.stdout.write("\n");

  kill(child);
  throw new Error(
    (exitedEarly ? "It exited early. " : "It timed out. ") +
      `Check the log:\n  tail -50 ${logPath}\n`,
  );
}

function kill(child: ReturnType<typeof spawn>): void {
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}
