import { activeBackend, config } from "./config.js";
import { requestModelName } from "./model-settings.js";
import type { Message, ToolCall, WireTool } from "./types.js";

/**
 * Client for mlx_lm.server. It speaks OpenAI's /v1/chat/completions, including
 * a `tools` parameter that it forwards to apply_chat_template — so Maple's
 * native <tool_call> format is handled server-side.
 *
 * The catch: that only works when the server's tool parsing succeeds. Maple is
 * a preview model at ~1B active params and regularly emits tool calls as raw
 * text instead of structured deltas, or emits JSON with trailing commas and
 * single quotes. Everything below the request function exists to cope with that.
 */

export interface CompletionResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  /** Everything the model emitted, before <think> splitting or repair. */
  rawContent: string;
  /** JSON repair altered the tool arguments — the model emitted malformed JSON. */
  repaired: boolean;
  /** A tool call was recovered from plain text because the server didn't parse it. */
  scavenged: boolean;
}

interface StreamHandlers {
  onContent?(delta: string): void;
  onReasoning?(delta: string): void;
}

export interface CompleteOptions {
  maxTokens?: number;
  /**
   * Override the sampling temperature for this one call.
   *
   * The default comes from config and suits open generation. Classification
   * does not want sampling at all: the router picking a specialist at
   * temperature 1.0 was measurably a dice roll — the same request routed
   * differently run to run — and a wrong route sends the request to a
   * specialist without the tools to serve it. Classifiers pass 0.
   */
  temperature?: number;
  /**
   * false pre-closes the model's <think> block through the chat template, so
   * generation starts where the answer goes. The template patch that makes
   * this possible lives in scripts/patch-runtime.mjs; against an unpatched
   * template the kwarg is simply unknown and thinking proceeds as before.
   */
  enableThinking?: boolean;
}

export async function complete(
  messages: Message[],
  tools: WireTool[],
  handlers: StreamHandlers = {},
  signal?: AbortSignal,
  opts: CompleteOptions = {},
): Promise<CompletionResult> {
  const body: Record<string, unknown> = {
    // Through the setting, not config: the served model can change at runtime
    // and requests must name the one actually loaded.
    model: requestModelName(),
    messages: messages.map(stripInternalFields),
    temperature: opts.temperature ?? config.temperature,
    top_p: config.topP,
    stream: true,
  };

  // Always an explicit positive cap. mlx-lm once read -1 as "no limit", but it
  // now validates max_tokens >= 0 and raises from inside the request handler,
  // killing the connection — the caller gets "fetch failed" with no status code
  // and nothing in it points at max_tokens. Every backend accepts a positive
  // value, so there is no longer a reason to vary this per backend.
  body.max_tokens = opts.maxTokens ?? config.maxTokens;
  if (opts.enableThinking === false) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  if (tools.length > 0) body.tools = tools;

  const res = await fetch(`${config.modelBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new ModelUnreachableError(
      `Model server returned ${res.status}. ${detail.slice(0, 300)}`,
    );
  }

  return consumeStream(res.body, handlers);
}

export class ModelUnreachableError extends Error {}

/** Drop fields the server doesn't understand before sending. */
function stripInternalFields(m: Message): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content ?? "" };
  if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.name) out.name = m.name;
  return out;
}

async function consumeStream(
  stream: ReadableStream<Uint8Array>,
  handlers: StreamHandlers,
): Promise<CompletionResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const partials = new Map<number, { id: string; name: string; args: string }>();

  let raw = "";
  let buffer = "";

  // <think>...</think> arrives interleaved with real content, split across
  // arbitrary chunk boundaries, so it has to be tracked as a running state.
  const think = new ThinkSplitter();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;

      let event: any;
      try {
        event = JSON.parse(payload);
      } catch {
        continue; // a truncated frame; the next read will carry the rest
      }

      const delta = event?.choices?.[0]?.delta;
      if (!delta) continue;

      if (typeof delta.content === "string" && delta.content.length > 0) {
        raw += delta.content;
        const { visible, reasoning } = think.push(delta.content);
        if (visible) handlers.onContent?.(visible);
        if (reasoning) handlers.onReasoning?.(reasoning);
      }

      // Some builds surface reasoning as its own field rather than <think>
      // tags, and they disagree on the name: DeepSeek-style servers send
      // reasoning_content, while the mlx-lm build Maple runs on sends
      // reasoning. Only the first was handled, so with Maple this branch never
      // fired -- reasoning was silently dropped, traces recorded none, and
      // anything watching the model think saw nothing happening at all.
      const reasoningDelta =
        typeof delta.reasoning_content === "string"
          ? delta.reasoning_content
          : typeof delta.reasoning === "string"
            ? delta.reasoning
            : null;
      if (reasoningDelta) {
        think.absorbReasoning(reasoningDelta);
        handlers.onReasoning?.(reasoningDelta);
      }

      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const slot = partials.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        partials.set(idx, slot);
      }
    }
  }

  let repaired = false;
  let scavenged = false;

  let toolCalls: ToolCall[] = [...partials.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, p], n) => {
      const fixed = repairJson(p.args);
      // Whitespace-only differences aren't worth flagging; anything else means
      // the model produced JSON that would not have parsed.
      if (p.args.trim() && fixed !== p.args.trim()) repaired = true;
      return {
        id: p.id || `call_${n}`,
        type: "function" as const,
        function: { name: p.name, arguments: fixed },
      };
    })
    .filter((t) => t.function.name.length > 0);

  let content = think.visibleText();

  // Fallback path: the server didn't parse the tool call, so it came through as
  // literal text. Recover it and strip it out of what the user sees.
  if (toolCalls.length === 0) {
    const recovered = scavengeToolCalls(content);
    if (recovered.calls.length > 0) {
      toolCalls = recovered.calls;
      content = recovered.remaining;
      scavenged = true;
    }
  }

  return {
    content: content.trim(),
    reasoning: think.reasoningText(),
    toolCalls,
    rawContent: raw,
    repaired,
    scavenged,
  };
}

/**
 * Splits a token stream into visible content and <think> reasoning, tolerating
 * tags that straddle chunk boundaries.
 */
class ThinkSplitter {
  private visible = "";
  private reasoning = "";
  private pending = "";
  private inThink = false;

  push(chunk: string): { visible: string; reasoning: string } {
    this.pending += chunk;
    let emittedVisible = "";
    let emittedReasoning = "";

    for (;;) {
      if (!this.inThink) {
        const open = this.pending.indexOf("<think>");
        if (open === -1) {
          // Hold back anything that might be the start of a split "<think>".
          const safe = this.pending.length - partialTagLength(this.pending, "<think>");
          if (safe > 0) {
            const text = this.pending.slice(0, safe);
            this.visible += text;
            emittedVisible += text;
            this.pending = this.pending.slice(safe);
          }
          break;
        }
        const text = this.pending.slice(0, open);
        this.visible += text;
        emittedVisible += text;
        this.pending = this.pending.slice(open + 7);
        this.inThink = true;
      } else {
        const close = this.pending.indexOf("</think>");
        if (close === -1) {
          const safe = this.pending.length - partialTagLength(this.pending, "</think>");
          if (safe > 0) {
            const text = this.pending.slice(0, safe);
            this.reasoning += text;
            emittedReasoning += text;
            this.pending = this.pending.slice(safe);
          }
          break;
        }
        const text = this.pending.slice(0, close);
        this.reasoning += text;
        emittedReasoning += text;
        this.pending = this.pending.slice(close + 8);
        this.inThink = false;
      }
    }

    return { visible: emittedVisible, reasoning: emittedReasoning };
  }

  absorbReasoning(text: string): void {
    this.reasoning += text;
  }

  /** Flush whatever is still held back. An unclosed <think> means the model ran
   *  out of tokens mid-thought; treat the remainder as reasoning, not content. */
  visibleText(): string {
    if (!this.inThink && this.pending) {
      this.visible += this.pending;
      this.pending = "";
    }
    return this.visible;
  }

  reasoningText(): string {
    if (this.inThink && this.pending) {
      this.reasoning += this.pending;
      this.pending = "";
    }
    return this.reasoning;
  }
}

/** How many trailing chars of `s` could be the beginning of `tag`. */
function partialTagLength(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

/** Pull <tool_call>{...}</tool_call> blocks out of plain text. */
function scavengeToolCalls(text: string): { calls: ToolCall[]; remaining: string } {
  const calls: ToolCall[] = [];
  const remaining = text.replace(
    /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g,
    (_match, inner: string) => {
      try {
        const parsed = JSON.parse(repairJson(inner));
        if (typeof parsed?.name === "string") {
          calls.push({
            id: `call_scavenged_${calls.length}`,
            type: "function",
            function: {
              name: parsed.name,
              arguments: JSON.stringify(parsed.arguments ?? parsed.parameters ?? {}),
            },
          });
        }
      } catch {
        /* unparseable — leave it out and let the loop tell the model */
      }
      return "";
    },
  );
  return { calls, remaining };
}

/**
 * Best-effort cleanup of the JSON small models actually produce. Only touches
 * things that are unambiguously wrong; returns the input untouched if it already
 * parses, so well-behaved output is never mangled.
 */
export function repairJson(input: string): string {
  const text = input.trim();
  if (!text) return "{}";
  try {
    JSON.parse(text);
    return text;
  } catch {
    /* fall through and try to fix it */
  }

  let s = text;
  // Strip markdown fences the model sometimes wraps around JSON.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  // Trailing commas before a closing brace/bracket.
  s = s.replace(/,\s*([}\]])/g, "$1");
  // Python-isms.
  s = s.replace(/\bNone\b/g, "null").replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false");

  try {
    JSON.parse(s);
    return s;
  } catch {
    /* keep going */
  }

  // Single-quoted keys and values, but only when there are no double quotes to
  // confuse — converting blindly would corrupt apostrophes inside strings.
  if (!s.includes('"')) {
    const swapped = s.replace(/'/g, '"');
    try {
      JSON.parse(swapped);
      return swapped;
    } catch {
      /* keep going */
    }
  }

  // Last resort: the outermost balanced {...} span.
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const slice = s.slice(start, end + 1);
    try {
      JSON.parse(slice);
      return slice;
    } catch {
      /* give up */
    }
  }

  return "{}";
}

/** Cheap liveness check so the CLI can give a useful error instead of ECONNREFUSED. */
export async function serverIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${config.modelBaseUrl}/models`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
