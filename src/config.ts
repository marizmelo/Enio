import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { BACKENDS, resolveBackend, type Backend } from "./backends.js";

/** Resolved without throwing so a typo in MAPLE_BACKEND surfaces as a clear
 *  error at startup rather than a crash while building the config object. */
function backendDefaults(id: string | undefined): Backend {
  return BACKENDS[(id ?? "maple").toLowerCase()] ?? BACKENDS.maple!;
}

/**
 * All configuration lives here. Everything is overridable by env var so the
 * project can be dropped onto someone else's machine and work unchanged.
 */

const home = homedir();

export const config = {
  /** Which engine to talk to: maple | ollama | lmstudio | llamacpp | custom. */
  backendId: process.env.MAPLE_BACKEND ?? "maple",

  /** Explicit overrides. When unset, the backend preset supplies these. */
  modelBaseUrl:
    process.env.MAPLE_BASE_URL ?? backendDefaults(process.env.MAPLE_BACKEND).baseUrl,
  modelName:
    process.env.MAPLE_MODEL ?? backendDefaults(process.env.MAPLE_BACKEND).model,

  /** Root of the mlx-lm-deepgrove checkout produced by the setup script. */
  mapleDir: process.env.MAPLE_DIR ?? join(home, "maple"),

  /** Everything this agent persists lives under here. Delete it to factory-reset. */
  dataDir: process.env.MAPLE_DATA_DIR ?? join(home, ".maple-agent"),

  /**
   * Filesystem + shell tools are hard-scoped to this directory. Nothing outside
   * it is readable or writable, no matter what the model asks for.
   */
  workspace: resolve(process.env.MAPLE_WORKSPACE ?? join(home, "maple-workspace")),

  /** Port for our own OpenAI-compatible endpoint (not the raw model server). */
  agentPort: Number(process.env.MAPLE_AGENT_PORT ?? 8787),

  /**
   * Bind address. Loopback by default. Prefer a tunnel (see tunnel.md) over
   * changing this — a tunnel needs no open inbound port at all, which is one
   * fewer thing that can be wrong.
   */
  agentHost: process.env.MAPLE_AGENT_HOST ?? "127.0.0.1",

  /** Local embedding model, run through ONNX in-process. ~130MB, downloaded once. */
  embeddingModel: process.env.MAPLE_EMBED_MODEL ?? "Xenova/bge-small-en-v1.5",

  /**
   * Search providers, tried in this order. SearXNG is preferred: self-hosted,
   * no key, no account. `docker compose up -d` in searxng/ starts one.
   * Remember to enable JSON output in its settings.yml or it returns 403.
   */
  searxngUrl: process.env.SEARXNG_URL ?? "",
  braveApiKey: process.env.BRAVE_API_KEY ?? "",
  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",

  /** Playwright page-load budget. SPAs are slow; this is not a network timeout. */
  browserTimeoutMs: Number(process.env.MAPLE_BROWSER_TIMEOUT ?? 30_000),

  /** Sampling defaults — these are the values DeepGrove benchmarks Maple with. */
  temperature: Number(process.env.MAPLE_TEMP ?? 1.0),
  topP: Number(process.env.MAPLE_TOP_P ?? 0.95),

  /** Safety rails on the agent loop. A small model can loop forever given the chance. */
  maxToolIterations: Number(process.env.MAPLE_MAX_ITERS ?? 8),
  maxToolOutputChars: 8000,

  /** Budget for the memory block injected into the system prompt. */
  memoryBlockChars: 4000,
  shellTimeoutMs: 60_000,

  /** MCP servers to connect to. Same shape as Claude Desktop's config. */
  mcpConfigPath: process.env.MAPLE_MCP_CONFIG ?? join(home, ".maple-agent", "mcp.json"),

  /**
   * Hard ceiling on how many tools reach the model at once. Maple has ~1B active
   * params; past roughly this many tool definitions it starts picking at random
   * instead of reasoning about which one fits.
   */
  maxExposedTools: Number(process.env.MAPLE_MAX_TOOLS ?? 16),

  /**
   * Route each turn to a specialist with a narrow tool set. Costs one short
   * extra call per turn and substantially improves tool selection. Set
   * MAPLE_ROUTING=0 to run as a single agent seeing every tool.
   */
  routingEnabled: process.env.MAPLE_ROUTING !== "0",
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
