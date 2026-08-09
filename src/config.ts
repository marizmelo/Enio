import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BACKENDS, resolveBackend, type Backend } from "./backends.js";
import { defaultBackendId } from "./platform.js";

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
  return BACKENDS[(id ?? defaultBackendId()).toLowerCase()] ?? BACKENDS.maple!;
}

/**
 * All configuration lives here. Everything is overridable by env var so the
 * project can be dropped onto someone else's machine and work unchanged.
 */
export const config = {
  /**
   * Which engine to talk to: maple | ollama | lmstudio | llamacpp | custom.
   * Defaults to maple on Apple Silicon and ollama everywhere else, because
   * defaulting to a backend the machine cannot run produces a confusing
   * connection error rather than a useful one.
   */
  backendId: env("BACKEND") ?? defaultBackendId(),

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

  /** Inspector UI. Always loopback-only — it exposes prompts and memory. */
  inspectPort: Number(env("INSPECT_PORT") ?? 8788),

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

  /**
   * Vision. Deliberately separate from the chat backend: the main model stays
   * text-only and images are turned into text before it sees them, so this can
   * be swapped without touching anything upstream.
   *
   * auto = describe with a VLM if one is available, otherwise OCR
   * ocr  = tesseract only, zero resident memory, no model needed
   * vlm  = require a vision model, error if missing
   * off  = report dimensions only
   */
  visionMode: env("VISION_MODE") ?? "auto",

  /**
   * moondream is the default because of memory, not quality: 1.7GB alongside
   * Maple's 6.9GB is comfortable on a 16GB machine. gemma3:4b or qwen3-vl:4b
   * describe better if you have the headroom.
   */
  visionModel: env("VISION_MODEL") ?? "moondream:v2",
  visionBaseUrl: env("VISION_URL") ?? "http://127.0.0.1:11434",

  /**
   * Which vision server to talk to: mlx | ollama | auto.
   *
   * auto prefers mlx-vlm and falls back to Ollama, because mlx-vlm is the same
   * runtime Maple already uses — one framework, one set of weights formats, and
   * no second daemon to install. Ollama remains supported because it is what
   * anyone already running it will have.
   */
  visionBackend: env("VISION_BACKEND") ?? "auto",

  /**
   * mlx-vlm's OpenAI-compatible server. Port chosen to avoid the four already
   * in play: 8080 model, 8081 llama.cpp's preset, 8787 agent, 8788 inspector.
   */
  visionMlxUrl: env("VISION_MLX_URL") ?? "http://127.0.0.1:8082",

  /**
   * Qwen3-VL-4B at 4-bit: ~2.5GB, and by a wide margin the most used VLM in
   * mlx-community, which matters for a format that breaks easily. It sits
   * beside Maple's 6.9GB without crowding a 16GB machine.
   */
  visionMlxModel: env("VISION_MLX_MODEL") ?? "mlx-community/Qwen3-VL-4B-Instruct-4bit",

  /**
   * Its own venv, deliberately. mlx-vlm depends on mlx-lm, and installing it
   * next to the Maple runtime risks pip replacing the editable checkout — which
   * carries the tool-parser patch that makes tool calls work at all.
   */
  visionVenvDir: env("VISION_VENV") ?? join(dataDir, "vision-venv"),

  /**
   * Whisper for dictation, in the same venv as the vision model.
   *
   * small rather than large-v3-turbo: ~500MB against ~1.5GB, and dictation is
   * short utterances in a quiet room by someone who can see the result and fix
   * it. The accuracy the larger model buys is mostly on long noisy audio, which
   * is not this.
   */
  voiceModel: env("VOICE_MODEL") ?? "mlx-community/whisper-small-mlx",

  /**
   * Which system voice reads replies. Empty means macOS's default, which is
   * Samantha on a stock install and sounds it.
   *
   * The good ones are downloads, not code: System Settings → Accessibility →
   * Spoken Content → System Voice → Manage Voices, where the Premium entries
   * are neural and land in the hundreds of megabytes. `say -v '?'` lists what
   * is actually installed. Kokoro through mlx-audio would be better still and
   * needs no download, but in 0.4.7 it builds its pipeline and then writes no
   * audio at all — through its own API as well as through mlx-vlm's server.
   */
  voiceName: env("VOICE") ?? "",

  /**
   * How many messages stay verbatim before older ones are folded into a
   * summary. Roughly twenty exchanges, which is longer than most sessions and
   * short enough that the prompt does not crowd out the answer.
   */
  historyWindow: Number(env("HISTORY_WINDOW") ?? 40),

  /**
   * Unload the vision model the instant it answers. Ollama's default is 5
   * minutes, which on a 16GB machine means it sits on top of Maple long after
   * it was needed. Set to "5m" if you attach images constantly and would
   * rather pay memory than reload time.
   */
  visionKeepAlive: env("VISION_KEEP_ALIVE") ?? 0,
  visionTimeoutMs: Number(env("VISION_TIMEOUT") ?? 120_000),

  /**
   * Overrides where OCR language data is read from. Normally unset: the data
   * ships as an npm dependency and is read from node_modules, so OCR never
   * touches the network.
   */
  tesseractLangPath: env("TESSERACT_LANG_PATH") ?? "",

  /**
   * SMTP. Withheld entirely unless host and from are set, so the tool never
   * exists in a state where it can only fail.
   */
  smtpHost: env("SMTP_HOST") ?? "",
  smtpPort: Number(env("SMTP_PORT") ?? 587),
  smtpUser: env("SMTP_USER") ?? "",
  smtpPass: env("SMTP_PASS") ?? "",
  emailFrom: env("EMAIL_FROM") ?? "",

  /**
   * Off by default: sending is irreversible, and deciding to send is exactly
   * the judgement a small model gets wrong. Until this is on, messages are
   * rendered to a .eml in the workspace so you can read what it would have sent.
   */
  emailSend: env("EMAIL_SEND") === "1",

  /** Optional recipient allowlist. Accepts addresses or "@domain" rules. */
  emailAllowedTo: (env("EMAIL_ALLOWED_TO") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * IMAP, for reading. Read-only in every operation — nothing here deletes,
   * moves, or marks messages read.
   *
   * Most providers now require an app-specific password rather than your
   * account password; Gmail and Outlook have largely disabled plain IMAP auth.
   */
  imapHost: env("IMAP_HOST") ?? "",
  imapPort: Number(env("IMAP_PORT") ?? 993),
  imapUser: env("IMAP_USER") ?? "",
  imapPass: env("IMAP_PASS") ?? "",

  /** Folders the model may open. Empty means all — worth narrowing. */
  imapFolders: (env("IMAP_FOLDERS") ?? "INBOX")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Desktop control: screenshots and AppleScript. Off by default because
   * AppleScript can do anything you can do, which meaningfully raises what a
   * wrong tool call costs.
   */
  desktopEnabled: env("DESKTOP") === "1",

  /** Playwright page-load budget. SPAs are slow; this is not a network timeout. */
  browserTimeoutMs: Number(env("BROWSER_TIMEOUT") ?? 30_000),

  /**
   * What the agent calls itself.
   *
   * Without this the model answers "who are you" with whatever identity its
   * weights carry -- the underlying model name -- which is accurate and useless:
   * the user is talking to enio, not to Maple, and the two have different
   * capabilities. Env-overridable so a fork does not have to patch a prompt.
   */
  agentName: env("NAME") ?? "Enio",

  /** Sampling defaults — these are the values DeepGrove benchmarks Maple with. */
  temperature: Number(env("TEMP") ?? 1.0),
  topP: Number(env("TOP_P") ?? 0.95),

  /**
   * Ceiling on a single completion, sent explicitly on every request.
   *
   * It has to be a positive number rather than "unlimited": mlx-lm validates
   * max_tokens >= 0 and raises from inside the request handler, which drops the
   * connection instead of returning a 400 — the client sees only "fetch
   * failed". Omitting the field is no better, since mlx-lm then falls back to
   * its own 512 default and truncates answers mid-sentence.
   *
   * The number itself is a latency rail. Maple's chat template appends a
   * <think> block on every generation unconditionally — there is no flag to
   * turn it off — and the model will reason until something cuts it off. So the
   * ceiling is what a turn costs in the bad case, and it trades two failures
   * against each other: too high and a one-line answer takes a minute, too low
   * and a question needing any deliberation returns *nothing at all*, because
   * the budget went entirely on reasoning that then gets stripped.
   *
   * 2048 is where those meet. Short answers stop early and are unaffected;
   * questions over an attachment come back with something rather than blank.
   * Raise ENIO_MAX_TOKENS if you would rather wait than be told less.
   */
  maxTokens: Number(env("MAX_TOKENS") ?? 2048),

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
