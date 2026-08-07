import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BACKENDS, resolveBackend, type Backend } from "./backends.js";

/** Repo root, from dist/config.js -> up two. */
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const home = homedir();

/**
 * Read `ENIO_<name>`, falling back to `MAPLE_<name>`.
 *
 * The project was called maple-agent before it was called enio. Anyone who set
 * those variables in a shell profile shouldn't have their setup silently stop
 * working because we renamed things — a config value that quietly reverts to a
 * default is far more confusing than one that errors.
 */
function env(name: string): string | undefined {
  return process.env[`ENIO_${name}`] ?? process.env[`MAPLE_${name}`];
}

/**
 * Where everything persistent lives: memory database, API key, MCP config,
 * and the model runtime.
 *
 * An existing `~/.maple-agent` is used as-is rather than being abandoned.
 * Silently starting fresh would look like total amnesia to anyone upgrading.
 */
function resolveDataDir(): string {
  const explicit = env("DATA_DIR");
  if (explicit) return explicit;

  const preferred = join(home, ".enio");
  if (existsSync(preferred)) return preferred;

  const previous = join(home, ".maple-agent");
  if (existsSync(previous)) return previous;

  return preferred;
}

const dataDir = resolveDataDir();

/**
 * Where the model runtime and weights live.
 *
 * Inside the data directory, alongside the database — machine-local state, not
 * source. Deliberately OUTSIDE the repo:
 *
 *  - Time Machine, iCloud and Dropbox crawl a project folder; 5.5GB of weights
 *    in it turns every backup into a slog.
 *  - IDE indexers and file watchers try to walk it.
 *  - `rm -rf` on the project, or re-cloning it, would otherwise cost a 5GB
 *    re-download. Keeping it out means the expensive part survives.
 *
 * Git never saw it either way — it has always been ignored — but "not in the
 * repo" and "not in the folder" are different problems, and only the second is
 * what tooling actually trips over.
 *
 * Earlier layouts are detected so upgrading never forces a re-download.
 */
function resolveRuntimeDir(): string {
  const explicit = env("DIR");
  if (explicit) return explicit;

  const preferred = join(dataDir, "runtime");
  if (existsSync(join(preferred, ".venv"))) return preferred;

  const previous = [
    join(home, ".maple-agent", "runtime"),
    join(projectRoot, "runtime"),
    join(home, "maple"),
  ];
  for (const candidate of previous) {
    if (existsSync(join(candidate, ".venv"))) return candidate;
  }

  return preferred;
}

/** Resolved without throwing so a typo in ENIO_BACKEND surfaces as a clear
 *  error at startup rather than a crash while building the config object. */
function backendDefaults(id: string | undefined): Backend {
  return BACKENDS[(id ?? "maple").toLowerCase()] ?? BACKENDS.maple!;
}

/**
 * All configuration lives here. Everything is overridable by env var so the
 * project can be dropped onto someone else's machine and work unchanged.
 */
export const config = {
  /** Which engine to talk to: maple | ollama | lmstudio | llamacpp | custom. */
  backendId: env("BACKEND") ?? "maple",

  /** Explicit overrides. When unset, the backend preset supplies these. */
  modelBaseUrl: env("BASE_URL") ?? backendDefaults(env("BACKEND")).baseUrl,
  modelName: env("MODEL") ?? backendDefaults(env("BACKEND")).model,

  /** The mlx-lm-deepgrove checkout and weights. See resolveRuntimeDir(). */
  runtimeDir: resolveRuntimeDir(),

  /** Everything enio persists lives under here. Delete it to factory-reset. */
  dataDir,

  /**
   * Filesystem + shell tools are hard-scoped to this directory. Nothing outside
   * it is readable or writable, no matter what the model asks for.
   */
  workspace: resolve(env("WORKSPACE") ?? join(home, "enio-workspace")),

  /** Port for our own OpenAI-compatible endpoint (not the raw model server). */
  agentPort: Number(env("AGENT_PORT") ?? 8787),

  /**
   * Bind address. Loopback by default. Prefer a tunnel (see tunnel.md) over
   * changing this — a tunnel needs no open inbound port at all, which is one
   * fewer thing that can be wrong.
   */
  agentHost: env("AGENT_HOST") ?? "127.0.0.1",

  /** Local embedding model, run through ONNX in-process. ~130MB, downloaded once. */
  embeddingModel: env("EMBED_MODEL") ?? "Xenova/bge-small-en-v1.5",

  /**
   * Search providers, tried in this order. SearXNG is preferred: self-hosted,
   * no key, no account. `docker compose up -d` in searxng/ starts one.
   * Remember to enable JSON output in its settings.yml or it returns 403.
   */
  searxngUrl: process.env.SEARXNG_URL ?? "",
  braveApiKey: process.env.BRAVE_API_KEY ?? "",
  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",

  /** Playwright page-load budget. SPAs are slow; this is not a network timeout. */
  browserTimeoutMs: Number(env("BROWSER_TIMEOUT") ?? 30_000),

  /** Sampling defaults — these are the values DeepGrove benchmarks Maple with. */
  temperature: Number(env("TEMP") ?? 1.0),
  topP: Number(env("TOP_P") ?? 0.95),

  /** Safety rails on the agent loop. A small model can loop forever given the chance. */
  maxToolIterations: Number(env("MAX_ITERS") ?? 8),
  maxToolOutputChars: 8000,

  /** Budget for the memory block injected into the system prompt. */
  memoryBlockChars: 4000,
  shellTimeoutMs: 60_000,

  /** MCP servers to connect to. Same shape as Claude Desktop's config. */
  mcpConfigPath: env("MCP_CONFIG") ?? join(dataDir, "mcp.json"),

  /**
   * Hard ceiling on how many tools reach the model at once. A ~1B-active model
   * starts picking at random rather than reasoning past roughly this many tool
   * definitions.
   */
  maxExposedTools: Number(env("MAX_TOOLS") ?? 16),

  /**
   * Route each turn to a specialist with a narrow tool set. Costs one short
   * extra call per turn and substantially improves tool selection. Set
   * ENIO_ROUTING=0 to run as a single agent seeing every tool.
   */
  routingEnabled: (env("ROUTING") ?? "1") !== "0",
} as const;

/** Throws on an unknown backend id, with the valid list. Call once at startup. */
export function activeBackend(): Backend {
  return resolveBackend(config.backendId);
}

export function ensureDirs(): void {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.workspace, { recursive: true });
}

export const dbPath = () => join(config.dataDir, "memory.db");
