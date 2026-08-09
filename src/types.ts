/** Shared shapes. Deliberately close to the OpenAI wire format so the
 *  server module can pass things through with minimal translation. */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** Maple emits <think> blocks; we strip them from content and keep them here. */
  reasoning?: string;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

/**
 * Structured display data a tool may emit alongside its text.
 *
 * The type is a closed set for the same reason the memory schema is: open-ended
 * types produce `map`, `Map` and `location_map` as three renderers for one
 * thing. A client that does not know a type renders the text instead, so adding
 * one here never breaks an older client.
 */
export type Widget =
  | { type: "clock"; label: string; iso: string; zone: string }
  | {
      type: "weather";
      place: string;
      condition: string;
      temperature: number;
      feelsLike: number;
      high: number;
      low: number;
      rainChance: number;
    }
  /**
   * An action the model wants to take and has not taken. Carries the exact
   * script so the user approves what will actually run, rather than a
   * description of it -- a summary the model wrote is not a thing to consent
   * to when the model is the unreliable part.
   */
  | { type: "plan"; id: string; summary: string; script: string };

/**
 * What a tool hands back.
 *
 * A bare string is still valid and is what almost every tool returns. The
 * object form exists for tools that can also be *shown*: `text` is what the
 * model reads and what any client without a renderer displays, so it must
 * stand alone. The widget is additive — never the only copy of the answer.
 */
export type ToolOutput = string | { text: string; widget?: Widget };

/** The text of a tool result, whichever form it came back in. */
export const toolText = (out: ToolOutput): string =>
  typeof out === "string" ? out : out.text;

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Where this tool came from, for display and for filtering. */
  origin: "builtin" | "mcp";
  server?: string;
  run(args: Record<string, unknown>): Promise<ToolOutput>;
}

/** OpenAI-format tool definition, i.e. what actually goes on the wire. */
export interface WireTool {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
}

export const toWireTool = (t: ToolDef): WireTool => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.parameters },
});
