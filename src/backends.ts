/**
 * Model backends.
 *
 * Everything here speaks OpenAI's /v1/chat/completions, so swapping the engine
 * is mostly a base URL. The presets exist because the *quirks* differ, and each
 * one below is a real incompatibility that silently breaks a request:
 *
 *  - mlx-lm accepts `max_tokens: -1` to mean "no limit". OpenAI and Ollama
 *    reject a negative value outright, so it has to be omitted rather than
 *    passed through.
 *  - Ollama needs the model tag ("qwen3:8b"), not a filesystem path.
 *  - llama.cpp's server ignores an unknown `model` field but requires the
 *    field to be present.
 */

export interface Backend {
  id: string;
  label: string;
  baseUrl: string;
  /** Default model identifier. Overridable with MAPLE_MODEL. */
  model: string;
  /** Whether `max_tokens: -1` is understood as "unlimited". */
  supportsUnlimitedTokens: boolean;
  /** Whether the server parses tool calls into structured deltas. When false,
   *  we lean harder on scavenging <tool_call> blocks out of the text. */
  nativeToolCalls: boolean;
  notes: string;
}

export const BACKENDS: Record<string, Backend> = {
  maple: {
    id: "maple",
    label: "Maple via mlx-lm (default)",
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "maple-2bit-mlx",
    supportsUnlimitedTokens: true,
    nativeToolCalls: true,
    notes: "Started by `maple up`. Fastest option on Apple Silicon.",
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3:8b",
    supportsUnlimitedTokens: false,
    nativeToolCalls: true,
    notes:
      "Set MAPLE_MODEL to any tag you have pulled. Tool calling requires a " +
      "model trained for it — most small instruct models are not.",
  },
  lmstudio: {
    id: "lmstudio",
    label: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    supportsUnlimitedTokens: false,
    nativeToolCalls: true,
    notes: "Start the local server from LM Studio's Developer tab first.",
  },
  llamacpp: {
    id: "llamacpp",
    label: "llama.cpp server",
    baseUrl: "http://127.0.0.1:8081/v1",
    model: "local",
    supportsUnlimitedTokens: false,
    nativeToolCalls: false,
    notes: "Run llama-server with --jinja for chat-template tool support.",
  },
  custom: {
    id: "custom",
    label: "Custom OpenAI-compatible endpoint",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "local",
    supportsUnlimitedTokens: false,
    nativeToolCalls: true,
    notes: "Set MAPLE_BASE_URL and MAPLE_MODEL.",
  },
};

export function resolveBackend(id: string | undefined): Backend {
  const key = (id ?? "maple").toLowerCase();
  const backend = BACKENDS[key];
  if (!backend) {
    const known = Object.keys(BACKENDS).join(", ");
    throw new Error(`Unknown backend "${id}". Available: ${known}`);
  }
  return backend;
}
