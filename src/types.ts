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

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Where this tool came from, for display and for filtering. */
  origin: "builtin" | "mcp";
  server?: string;
  run(args: Record<string, unknown>): Promise<string>;
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
