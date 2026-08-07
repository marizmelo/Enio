import { config } from "./config.js";
import { complete } from "./model.js";
import { buildMemoryBlock, logMessage } from "./memory/store.js";
import { recordTurn, type StepRecord } from "./memory/traces.js";
import { exemplarBlock, preferenceBlock } from "./memory/learning.js";
import { getSpecialist, route, toolsFor } from "./specialists.js";
import { skillCatalogue } from "./skills.js";
import { invokedSkillBlock } from "./mentions.js";
import type { Skill } from "./skills.js";
import { safePath } from "./tools/fs.js";
import { readFile } from "node:fs/promises";
import { isImage, readImage } from "./vision.js";
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

/** Per-turn overrides from /skill and @mention syntax. */
export interface TurnOverrides {
  specialist?: string | null;
  skills?: Skill[];
  files?: string[];
  servers?: string[];
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
  overrides: TurnOverrides = {},
): Promise<TurnResult> {
  // Routing, memory and exemplar lookup are independent — run them together
  // rather than paying for three sequential round trips.
  // An explicit @specialist skips the routing call entirely — the user has
  // already made the decision the router exists to make.
  const [routed, memoryBlock, exemplars, attachments] = await Promise.all([
    overrides.specialist
      ? Promise.resolve(overrides.specialist)
      : config.routingEnabled
        ? route(userInput)
        : Promise.resolve(""),
    buildMemoryBlock(userInput),
    exemplarBlock(userInput),
    readAttachments(overrides.files ?? []),
  ]);
  const specialistName = routed;

  let activeTools = registry.all;
  let roleSystem = BASE_SYSTEM;

  if (specialistName) {
    const specialist = getSpecialist(specialistName);
    activeTools = toolsFor(specialist, registry);

    // @server widens the specialist's view for this turn only.
    for (const server of overrides.servers ?? []) {
      for (const tool of registry.all) {
        if (tool.server === server && !activeTools.includes(tool)) activeTools.push(tool);
      }
    }

    roleSystem = `${specialist.systemPrompt}\n\n${SHARED_RULES}`;
    handlers.onRoute?.(specialist.name);
  }

  // Order matters: role, then how the user wants things done, then what is
  // known, then worked examples. Skills sit with the role because they change
  // *how* the task is approached rather than supplying facts about it.
  // An explicitly invoked skill goes in ahead of the catalogue: it is no longer
  // one option among many, it is the instruction for this turn.
  const invoked = invokedSkillBlock(overrides.skills ?? []);
  const system = [
    roleSystem,
    invoked,
    invoked ? "" : skillCatalogue(),
    preferenceBlock(),
    memoryBlock,
    exemplars,
    attachments,
  ]
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

  // Diagnostic trace, written once at the end of the turn. Kept out of the hot
  // path -- a failed trace write must never break a working conversation.
  const turnStartedAt = Date.now();
  const steps: StepRecord[] = [];
  let iterations = 0;

  for (let iteration = 0; iteration < config.maxToolIterations; iteration++) {
    const isLast = iteration === config.maxToolIterations - 1;
    iterations = iteration + 1;
    const modelStartedAt = Date.now();

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

    steps.push({
      seq: steps.length,
      kind: "model",
      rawContent: result.rawContent,
      reasoning: result.reasoning || null,
      repaired: result.repaired,
      scavenged: result.scavenged,
      durationMs: Date.now() - modelStartedAt,
    });

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
      const toolStartedAt = Date.now();
      const output = await executeCall(call, registry, handlers);
      toolsUsed.push(call.function.name);
      steps.push({
        seq: steps.length,
        kind: "tool",
        name: call.function.name,
        args: call.function.arguments,
        output,
        // executeCall converts throws into text, so treat the prefix as the signal.
        error: output.startsWith("Error:") ? output.slice(0, 300) : null,
        durationMs: Date.now() - toolStartedAt,
      });
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

  try {
    recordTurn({
      sessionId,
      question: userInput,
      reply,
      specialist: specialistName || "single",
      systemPrompt: system,
      memoryBlock,
      startedAt: turnStartedAt,
      durationMs: Date.now() - turnStartedAt,
      iterations,
      steps,
    });
  } catch {
    // Tracing is diagnostic. Losing a trace is annoying; losing the user's
    // answer because the trace insert failed would be unacceptable.
  }

  return {
    reply,
    messages: history,
    toolsUsed,
    specialist: specialistName || "single",
    question: userInput,
  };
}

/**
 * Attached files are read here rather than left to a tool call. The user
 * naming a file is unambiguous, and spending a round trip for the model to
 * request what it was already handed is pure latency.
 */
async function readAttachments(files: string[]): Promise<string> {
  if (files.length === 0) return "";
  const blocks: string[] = [];

  for (const rel of files.slice(0, 5)) {
    try {
      const absolute = safePath(rel);

      // An attached image is converted to text here rather than being handed
      // to the model. That is what lets a text-only model handle images at
      // all, and it means the vision model is an implementation detail.
      if (isImage(rel)) {
        const reading = await readImage(absolute);
        blocks.push(
          `<image path="${rel}" read-by="${reading.method}">\n${reading.text}\n</image>`,
        );
        continue;
      }

      const text = await readFile(absolute, "utf8");
      const clipped =
        text.length > 12_000 ? text.slice(0, 12_000) + "\n[...truncated]" : text;
      blocks.push(`<file path="${rel}">\n${clipped}\n</file>`);
    } catch (err) {
      blocks.push(`<file path="${rel}">could not read: ${(err as Error).message}</file>`);
    }
  }

  return `The user attached these. Images have already been read for you — the\ntext below is what they contain.\n\n${blocks.join("\n\n")}`;
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
