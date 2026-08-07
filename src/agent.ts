import { config } from "./config.js";
import { complete } from "./model.js";
import { buildMemoryBlock, logMessage } from "./memory/store.js";
import { exemplarBlock, preferenceBlock } from "./memory/learning.js";
import { getSpecialist, route, toolsFor } from "./specialists.js";
import type { Registry } from "./tools/index.js";
import { toWireTool, type Message, type ToolCall } from "./types.js";

const SHARED_RULES = `Call one tool at a time and read the result before deciding what to do next.
If a tool returns an error, read the error and adapt — do not call it again unchanged.
When you have enough information, answer directly and concisely.`;

/** Used when routing is disabled, so behaviour is unchanged from single-agent mode. */
const BASE_SYSTEM = `You are a helpful local assistant running entirely on the user's own machine.

You have tools. Use them rather than guessing:
- Call recall when the user refers to something from a previous conversation, or when what you know about them would change your answer.
- Call remember when the user tells you something durable about themselves, their preferences, or their work.
- Use the file and command tools to inspect and modify things in the workspace rather than speculating about what they contain.
- Use web tools for anything that may have changed recently.

${SHARED_RULES}`;

export interface TurnHandlers {
  onReasoning?(delta: string): void;
  onContent?(delta: string): void;
  onToolStart?(name: string, args: Record<string, unknown>): void;
  onToolEnd?(name: string, result: string): void;
  onNotice?(text: string): void;
  onRoute?(specialist: string): void;
}

export interface TurnResult {
  reply: string;
  messages: Message[];
  toolsUsed: string[];
  specialist: string;
  /** The question that produced this reply, so the caller can save an exemplar. */
  question: string;
}

/**
 * Runs one user turn to completion, including any tool round-trips.
 *
 * `history` is mutated so the caller keeps the full conversation, tool calls
 * included — Maple's chat template expects assistant tool_calls to be followed
 * by matching tool results, and dropping them produces incoherent follow-ups.
 */
export async function runTurn(
  userInput: string,
  history: Message[],
  registry: Registry,
  sessionId: string,
  handlers: TurnHandlers = {},
): Promise<TurnResult> {
  // Routing, memory and exemplar lookup are independent — run them together
  // rather than paying for three sequential round trips.
  const [specialistName, memoryBlock, exemplars] = await Promise.all([
    config.routingEnabled ? route(userInput) : Promise.resolve(""),
    buildMemoryBlock(userInput),
    exemplarBlock(userInput),
  ]);

  let activeTools = registry.all;
  let roleSystem = BASE_SYSTEM;

  if (specialistName) {
    const specialist = getSpecialist(specialistName);
    activeTools = toolsFor(specialist, registry);
    roleSystem = `${specialist.systemPrompt}\n\n${SHARED_RULES}`;
    handlers.onRoute?.(specialist.name);
  }

  const system = [roleSystem, preferenceBlock(), memoryBlock, exemplars]
    .filter(Boolean)
    .join("\n\n");

  // The system message is rebuilt each turn so retrieved memory tracks what is
  // actually being discussed rather than being frozen at session start.
  if (history.length > 0 && history[0]!.role === "system") {
    history[0] = { role: "system", content: system };
  } else {
    history.unshift({ role: "system", content: system });
  }

  history.push({ role: "user", content: userInput });
  logMessage(sessionId, "user", userInput);

  const wireTools = activeTools.map(toWireTool);
  const toolsUsed: string[] = [];
  let reply = "";

  for (let iteration = 0; iteration < config.maxToolIterations; iteration++) {
    const isLast = iteration === config.maxToolIterations - 1;

    const result = await complete(
      history,
      // On the final permitted iteration, withhold tools so the model is forced
      // to produce an answer instead of another call it has no budget to run.
      isLast ? [] : wireTools,
      {
        onReasoning: handlers.onReasoning,
        onContent: handlers.onContent,
      },
    );

    if (result.toolCalls.length === 0) {
      reply = result.content;
      history.push({
        role: "assistant",
        content: result.content,
        reasoning: result.reasoning,
      });
      logMessage(sessionId, "assistant", result.content);
      break;
    }

    history.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls,
      reasoning: result.reasoning,
    });

    for (const call of result.toolCalls) {
      const output = await executeCall(call, registry, handlers);
      toolsUsed.push(call.function.name);
      history.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: output,
      });
    }

    if (isLast) {
      handlers.onNotice?.(
        `Stopped after ${config.maxToolIterations} tool rounds. ` +
          `Raise ENIO_MAX_ITERS if this was a genuinely long task.`,
      );
    }
  }

  return {
    reply,
    messages: history,
    toolsUsed,
    specialist: specialistName || "single",
    question: userInput,
  };
}

async function executeCall(
  call: ToolCall,
  registry: Registry,
  handlers: TurnHandlers,
): Promise<string> {
  const tool = registry.byName.get(call.function.name);

  if (!tool) {
    // Hallucinated tool names are common with small models. Telling the model
    // exactly what does exist recovers the turn far more often than a bare error.
    const available = [...registry.byName.keys()].join(", ");
    return `No tool named "${call.function.name}". Available tools: ${available}`;
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return `Arguments for ${tool.name} were not valid JSON. Send a JSON object matching the tool's schema.`;
  }

  const missing = (tool.parameters.required ?? []).filter(
    (key) => args[key] === undefined,
  );
  if (missing.length > 0) {
    return `Missing required argument${missing.length > 1 ? "s" : ""} for ${tool.name}: ${missing.join(", ")}.`;
  }

  handlers.onToolStart?.(tool.name, args);
  try {
    const raw = await tool.run(args);
    const output =
      raw.length > config.maxToolOutputChars
        ? raw.slice(0, config.maxToolOutputChars) + "\n[...truncated]"
        : raw;
    handlers.onToolEnd?.(tool.name, output);
    return output;
  } catch (err) {
    const message = `Error: ${(err as Error).message}`;
    handlers.onToolEnd?.(tool.name, message);
    return message;
  }
}
