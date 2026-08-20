import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, openSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { serverIsUp } from "./model.js";
import {
  otherModelClients,
  registerModelClient,
  unregisterModelClient,
} from "./model-clients.js";
import { canRunMaple, isWindows, whyNoMaple } from "./platform.js";
import {
  MAPLE,
  currentModelId,
  currentModelLabel,
  currentModelPath,
  modelIsCached,
  setModelId,
} from "./model-settings.js";

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
/**
 * Is a model server already loading, or already up?
 *
 * `serverIsUp` asks over HTTP, which is the right question once the server
 * listens and the wrong one for the ninety seconds it spends reading 5GB of
 * weights off disk first. During that window a second launch sees a free port
 * and starts another server, and two of them is roughly 12GB -- enough to put
 * a 24GB machine into swap, which is what it looks like when the whole
 * computer stops responding while the app is starting.
 *
 * So this asks the other question: is such a process already running at all.
 * Matched on the command line rather than a pidfile, because a pidfile has to
 * survive a crash to be worth anything and this needs no cleanup to be
 * correct.
 */
/**
 * How long to wait for a model server someone else is starting, in 2s ticks.
 *
 * Bounded by the desktop's own patience rather than by how long a load can
 * take. Waiting longer than the caller will wait is worse than starting a
 * duplicate: the app reports "Maple did not respond" and never goes on to
 * start the agent, so nothing works at all -- which is exactly what an
 * unbounded 180s wait did against a 120s timeout.
 */
export const WAIT_FOR_EXISTING_TICKS = 45;

export function modelServerPid(): number | null {
  try {
    const out = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      // Structural match on the actual invocation rather than the bare string
      // "mlx_lm.server", which also appears in any shell command that mentions
      // it -- including the diagnostics people run while debugging this. A
      // false positive costs ninety seconds of waiting for a server that does
      // not exist.
      // Either interpreter name: "Enio Model" is the symlink we launch under
      // now, "python" covers a server started by an older build or by hand.
      // Missing one of them would mean starting a duplicate beside it, or
      // failing to reap it -- the two failures this whole mechanism exists to
      // prevent.
      const isModelServer =
        /(python[\d.]*|Enio Model)["']?\s+-m\s+mlx_lm\.server/.test(match[2]!);
      if (pid !== process.pid && isModelServer) {
        return pid;
      }
    }
  } catch {
    // ps is missing or refused; treat as "cannot tell" and let the HTTP check
    // decide, which is the behaviour this had before.
  }
  return null;
}

/**
 * The model server's python binary, under a name worth reading.
 *
 * Activity Monitor's Process Name column is the executable's last path
 * component, so the process holding six gigabytes showed up as "python" among
 * whatever else on the machine is also python. A symlink beside the real
 * interpreter fixes that without touching the venv: CPython resolves its
 * prefix from the directory the executable lives in, and a sibling symlink is
 * still in that directory -- verified by importing mlx through it.
 *
 * Falls back to plain python if the link cannot be made. A readable name in a
 * process list is not worth failing a launch over.
 */
export function venvPythonPath(): string {
  return join(config.runtimeDir, ".venv", "bin", "python");
}

export function modelServerBinary(): string {
  const real = venvPythonPath();
  const friendly = join(dirname(real), MODEL_PROCESS_NAME);
  try {
    if (!existsSync(friendly)) symlinkSync(real, friendly);
    return friendly;
  } catch {
    return real;
  }
}

/** Shown in Activity Monitor. Kept in step with the matcher below. */
export const MODEL_PROCESS_NAME = "Enio Model";

/** The port the configured base URL names, so the server we start is the one
 *  everything else is pointed at. Hardcoding 8080 here while the agent read
 *  ENIO_BASE_URL meant an overridden setup started a server nobody would call. */
export function modelServerPort(): string {
  try {
    return new URL(config.modelBaseUrl).port || "8080";
  } catch {
    return "8080";
  }
}

export function modelServerArgs(modelPath: string): string[] {
  return [
    "-m", "mlx_lm.server",
    "--model", modelPath,
    "--trust-remote-code",
    "--flash-head",
    "--prompt-cache-bytes", `${config.promptCacheGb}G`,
    // The one that actually bounds memory: --prompt-cache-bytes did not stop
    // ten slots of long-generation KV from reaching 24GB on a 24GB machine.
    "--prompt-cache-size", `${config.promptCacheSlots}`,
    "--port", modelServerPort(),
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

/**
 * A claim on a model server this process did not start.
 *
 * Releasing it shuts the server down only if nothing else still wants it --
 * "last one out", rather than "whoever started it". The process that started
 * it may well exit first, which is exactly the case that used to kill an
 * attached CLI mid-answer.
 */
function sharedClaim(): RunningBackend {
  registerModelClient();
  return { stop: releaseSharedClaim };
}

function releaseSharedClaim(): void {
  if (unregisterModelClient().length > 0) return;
  const pid = modelServerPid();
  if (pid === null) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

/**
 * Claim the shared model server for the lifetime of this process.
 *
 * For the entry points that attach to a server rather than start one --
 * `enio chat`, `enio serve` -- which previously just probed the port and
 * carried on. Being invisible to the count is what let the desktop decide it
 * was the last user and shut the model down mid-session.
 *
 * The claim is released on the way out however that happens, and if this turns
 * out to be the last process using the server, it shuts it down: the process
 * that started it is not necessarily the one that should end it, and something
 * has to, or a quit desktop leaves five gigabytes behind.
 */
export function claimModelServer(): void {
  if (config.backendId !== "maple") return; // not ours to manage
  registerModelClient();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseSharedClaim();
  };

  process.on("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      release();
      process.exit(0);
    });
  }
}

/**
 * Swap what the model server is serving, in place.
 *
 * Persist first, then stop the running server, then start one -- which reads
 * the setting just written. Persisting first is what makes a crash mid-swap
 * self-healing: whatever brings the server up next serves the chosen model,
 * rather than the machine flip-flopping depending on which process died.
 *
 * Only meaningful for our own server; a switched model on Ollama's system
 * service is Ollama's business.
 */
export async function switchModel(id: string, opts: EnsureOptions): Promise<void> {
  const previous = currentModelId();
  setModelId(id);

  const pid = modelServerPid();
  if (pid !== null) {
    opts.log(`Stopping the model server (pid ${pid}) to switch models`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    // The port has to actually free before the replacement binds it.
    for (let i = 0; i < 15 && modelServerPid() !== null; i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  try {
    await startMaple(opts);
  } catch (err) {
    // The setting persists before the attempt so a crash mid-swap heals
    // forward -- but a model that will not *load* must not stay chosen, or
    // every boot from here on serves ninety seconds of failure. Put the old
    // one back, on disk and running.
    opts.log(`${id} failed to start; reverting to ${previous}`);
    setModelId(previous);
    await startMaple(opts).catch(() => {});
    throw err;
  }
}

export async function ensureBackend(opts: EnsureOptions): Promise<RunningBackend> {
  if (await serverIsUp()) {
    opts.log(`Using the ${config.backendId} server already running on ${config.modelBaseUrl}`);
    // Ollama is a system service somebody else manages; joining a count that
    // could decide to shut it down would be overreach. Our own server is
    // shared, so attaching to it is a claim like any other.
    return config.backendId === "maple" ? sharedClaim() : NOOP;
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

  const venvPython = venvPythonPath();
  if (!existsSync(venvPython)) {
    throw new Error(
      `No model runtime found at ${config.runtimeDir}\n\n` +
        `Install it with:   bash install.sh\n` +
        `Point elsewhere:   ENIO_DIR=/path/to/runtime\n`,
    );
  }

  // Already starting under another launcher: wait for it rather than adding a
  // second copy of a five-gigabyte process.
  const existing = modelServerPid();
  if (existing !== null) {
    opts.log(`A model server is already starting (pid ${existing}) — waiting for it`);
    for (let i = 0; i < WAIT_FOR_EXISTING_TICKS; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await serverIsUp()) return NOOP;
      if (modelServerPid() === null) break; // it died; fall through and start one
    }
    if (await serverIsUp()) return NOOP;
  }

  const logPath = join(config.dataDir, "model-server.log");
  const log = openSync(logPath, "a");

  // The persisted model setting decides what gets served -- which is what
  // lets the choice survive the restart cycle: quitting the app shuts down
  // whichever server it was using, and before this the relaunch could only
  // ever bring Maple back. An HF id resolves from the local HF cache.
  //
  // An HF id whose weights are not cached yet would be handed to
  // mlx_lm.server, which downloads it silently -- gigabytes nobody agreed
  // to, timing out waitForServer halfway through. Ask first; a declined (or
  // non-interactive) answer falls back to the bundled Maple weights when
  // they exist, so a machine upgraded across the default-model change keeps
  // working without a surprise download.
  let id = currentModelId();
  if (id !== MAPLE && !modelIsCached(id)) {
    const wanted = await opts.confirm(`Download ${id}? (a few GB, one time)`);
    if (!wanted) {
      if (existsSync(join(config.runtimeDir, "maple-2bit-mlx", "config.json"))) {
        opts.log(`Weights for ${id} are not downloaded — serving Maple instead`);
        id = MAPLE;
      } else {
        throw new Error(
          `No weights for ${id} and no bundled Maple weights to fall back to.\n` +
            `Run 'bash install.sh' or download from the desktop model picker.`,
        );
      }
    }
  }
  const modelPath = id === MAPLE ? join(config.runtimeDir, "maple-2bit-mlx") : currentModelPath();
  const label = id === MAPLE ? "Maple" : currentModelLabel();

  const child = spawn(
    modelServerBinary(),
    modelServerArgs(modelPath),
    { cwd: config.runtimeDir, stdio: ["ignore", log, log] },
  );

  await waitForServer(child, opts, 90, `Starting ${label} — first load reads the weights`, logPath);

  // Registered even though we started it: by the time we exit, a CLI or the
  // desktop may have attached, and starting it does not entitle us to end it.
  registerModelClient();
  return {
    stop: () => {
      if (unregisterModelClient().length > 0) {
        opts.log("Leaving the model server up — another enio process is using it");
        return;
      }
      kill(child);
    },
  };
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
