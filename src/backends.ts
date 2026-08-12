/**
 * Model backends.
 *
 * Everything here speaks OpenAI's /v1/chat/completions, so swapping the engine
 * is mostly a base URL. The presets exist because the *quirks* differ, and each
 * one below is a real incompatibility that silently breaks a request:
 *
 *  - max_tokens used to vary per backend, because mlx-lm read -1 as "no limit"
 *    while OpenAI and Ollama 400 on a negative value. Current mlx-lm validates
 *    it too, and raises from inside the request handler rather than returning a
 *    status, so the client sees a dropped connection. Every backend now gets
 *    one explicit positive cap (`config.maxTokens`) and the flag is gone.
 *  - Ollama needs the model tag ("qwen3:8b"), not a filesystem path.
 *  - llama.cpp's server ignores an unknown `model` field but requires the
 *    field to be present.
 */

export interface Backend {
  id: string;
  label: string;
  baseUrl: string;
  /** Default model identifier. Overridable with ENIO_MODEL. */
  model: string;
  /** Whether the server parses tool calls into structured deltas. When false,
   *  we lean harder on scavenging <tool_call> blocks out of the text. */
  nativeToolCalls: boolean;
  notes: string;
}

export const BACKENDS: Record<string, Backend> = {
  // The id predates the rename of the default model: "maple" here means the
  // mlx-lm server enio manages itself, whatever model it serves. Changing the
  // id would break every ENIO_BACKEND=maple already written down.
  maple: {
    id: "maple",
    label: "MLX via mlx-lm (default)",
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "maple-2bit-mlx",
    nativeToolCalls: true,
    notes: "Started by `enio up`. Serves the selected MLX model on Apple Silicon.",
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3:8b",
    nativeToolCalls: true,
    notes:
      "Set ENIO_MODEL to any tag you have pulled. Tool calling requires a " +
      "model trained for it — most small instruct models are not. On Apple " +
      "Silicon, Ollama ≥0.30 serves safetensors tags of supported " +
      "architectures on its MLX engine (~2x decode); GGUF tags, including " +
      "the default here, stay on llama.cpp.",
  },
  lmstudio: {
    id: "lmstudio",
    label: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    nativeToolCalls: true,
    notes: "Start the local server from LM Studio's Developer tab first.",
  },
  llamacpp: {
    id: "llamacpp",
    label: "llama.cpp server",
    baseUrl: "http://127.0.0.1:8081/v1",
    model: "local",
    nativeToolCalls: false,
    notes: "Run llama-server with --jinja for chat-template tool support.",
  },
  custom: {
    id: "custom",
    label: "Custom OpenAI-compatible endpoint",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "local",
    nativeToolCalls: true,
    notes: "Set ENIO_BASE_URL and ENIO_MODEL.",
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
