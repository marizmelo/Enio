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
import { createHash } from "node:crypto";
import { toWireTool, type Message, type ToolCall, type Widget } from "./types.js";

/**
 * Who the assistant is, ahead of everything else in the system message.
 *
 * A model asked its name answers from its weights, so it introduces itself as
 * the base model. That is the wrong answer twice over: the user is talking to
 * enio rather than to the model underneath, and the two do not have the same
 * capabilities -- enio has tools, memory and skills that the weights know
 * nothing about. Stated once here rather than in each specialist prompt, so
 * every route gives the same answer.
 */
const IDENTITY = `You are ${config.agentName}, the user's personal assistant. Everything here runs on their own computer.

The conversation so far appears above each new message. Earlier messages in it are yours to read, quote and answer from — when the user asks about something said earlier, look at the messages above and answer from them.

When asked who or what you are, answer as ${config.agentName}. ${config.agentName} is the assistant's name; do not name or describe any underlying model.`;

// Each line here was chosen by measurement, not by style, and they are not
// uniform on purpose. The image sentence keeps its never-say clause because
// removing it measurably dropped correct answers (3/3 with, 2/4 without). The
// live-info sentence lost its never-say clause because the embedded phrase
// ("you have no access to real-time information") is disclaimer-shaped, and
// the positive form measured just as well. The conversation-awareness wording
// lives in IDENTITY, where the old privacy/memory-negation phrasing was the
// reproducible trigger for "I don't have access to previous conversations" on
// questions about the current thread. Sample sizes are small and the model is
// stochastic at temp 1.0 — re-measure before re-wording.
const SHARED_RULES = `You can read images. Anything the user attached has already been read and its contents are included below; for any other image in the workspace, call read_image. So never tell the user you are unable to see or view an image — describing what an image contains is something you do, and the answer is either already in front of you or one tool call away.

You can look up live information: the weather where the user is, and the current date and time. Check with a tool, then answer from what it returned.

Call one tool at a time and read the result before deciding what to do next.
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
  /** Structured display data from a tool. Clients that cannot render it simply
   *  do not implement this — the tool's text has already been delivered. */
  onWidget?(widget: Widget): void;
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
 * Summaries of the older part of a conversation, keyed by what they summarise.
 *
 * The server rebuilds history from the client on every request, so without a
 * cache the same forty messages would be re-summarised every turn -- an extra
 * model call per turn, growing with the conversation. Keyed by a hash of the
 * exact messages folded in, so it stays correct when a client edits or
 * branches history rather than merely appending.
 */
const summaryCache = new Map<string, string>();

function historyKey(messages: Message[]): string {
  return createHash("sha256")
    .update(messages.map((m) => `${m.role}:${m.content ?? ""}`).join("\u0000"))
    .digest("hex");
}

/**
 * Fold everything older than the window into one summary, keeping recent turns
 * verbatim.
 *
 * A long conversation eventually stops fitting, and what happens then is not a
 * clean error: the oldest messages fall out of the model's attention silently
 * and it starts contradicting things it was told. Summarising is lossy, but it
 * is lossy in a way that is visible in the prompt rather than invisible in the
 * weights.
 *
 * Recent turns are kept whole because that is where pronouns point. A summary
 * of "the user asked about the deploy script" cannot resolve "run it again".
 */
async function compactHistory(history: Message[]): Promise<Message[]> {
  const system = history[0]?.role === "system" ? history[0] : null;
  const rest = system ? history.slice(1) : history;

  if (rest.length <= config.historyWindow) return history;

  const older = rest.slice(0, rest.length - config.historyWindow);
  const recent = rest.slice(rest.length - config.historyWindow);
  const key = historyKey(older);

  let summary = summaryCache.get(key);
  if (!summary) {
    const transcript = older
      .map((m) => `${m.role}: ${String(m.content ?? "").slice(0, 2000)}`)
      .join("\n");

    try {
      const result = await complete(
        [
          {
            role: "system",
            content:
              "Summarise this earlier part of a conversation so it can stand in " +
              "for the messages themselves. Keep names, decisions, numbers, file " +
              "paths and anything the user asked to be remembered. Drop " +
              "pleasantries. Write it as notes, not prose, under 200 words.",
          },
          { role: "user", content: transcript },
        ],
        [],
        {},
        undefined,
        { maxTokens: config.maxTokens },
      );
      summary = result.content.trim();
    } catch {
      summary = "";
    }

    // An empty summary is not cached: it means the model failed, and the next
    // turn deserves another attempt rather than a permanent hole.
    if (summary) summaryCache.set(key, summary);
  }

  // Without a summary, drop to the window anyway. Losing the old messages is
  // what was going to happen regardless; doing it deliberately at least keeps
  // the recent ones intact.
  const folded: Message[] = summary
    ? [{ role: "system", content: `Earlier in this conversation:\n\n${summary}` }]
    : [];

  return [...(system ? [system] : []), ...folded, ...recent];
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
  const attachmentNotes: string[] = [];
  const [routed, memoryBlock, exemplars, attachments] = await Promise.all([
    overrides.specialist
      ? Promise.resolve(overrides.specialist)
      : config.routingEnabled
        ? route(userInput)
        : Promise.resolve(""),
    buildMemoryBlock(userInput),
    exemplarBlock(userInput),
    readAttachments(overrides.files ?? [], attachmentNotes),
  ]);
  const specialistName = routed;

  for (const note of new Set(attachmentNotes)) handlers.onNotice?.(note);

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
    IDENTITY,
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

  // Fold older turns before the model sees any of them. Done in place, so the
  // caller's own record shrinks too -- a REPL that kept the full array would
  // send it all back next turn and undo this immediately.
  if (history.length - 1 > config.historyWindow) {
    const compacted = await compactHistory(history);
    history.splice(0, history.length, ...compacted);
  }

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

  /**
   * The empty answer, which is the worst failure this loop has.
   *
   * Maple's template opens a <think> block on every generation and on some
   * prompts the model reasons to the token ceiling without ever writing the
   * answer. From the user's side the agent simply said nothing. Raising the
   * ceiling does not fix it -- 8192 tokens of budget ran out the same way in
   * testing -- and an earlier retry that merely asked the model not to think
   * failed, because the template forces the block open regardless of what the
   * prompt requests.
   *
   * So the retry declines thinking structurally: the template pre-closes the
   * think block (Qwen3's own no-think pattern), and generation starts where
   * the answer goes. Same history, same attachments, no room to ruminate.
   * Measured directly this answers in under a second where the thinking run
   * burned its whole budget.
   */
  if (!reply.trim()) {
    handlers.onNotice?.("The reply budget went entirely on thinking — answering again without it.");
    const retryStartedAt = Date.now();
    try {
      const retry = await complete(
        history,
        [],
        { onContent: handlers.onContent },
        undefined,
        { enableThinking: false },
      );
      steps.push({
        seq: steps.length,
        kind: "model",
        rawContent: retry.rawContent,
        reasoning: retry.reasoning || null,
        repaired: retry.repaired,
        scavenged: retry.scavenged,
        durationMs: Date.now() - retryStartedAt,
      });
      if (retry.content.trim()) {
        reply = retry.content.trim();
        // The loop already pushed the empty assistant turn; replace it rather
        // than leaving a blank message in front of the real one.
        const last = history[history.length - 1];
        if (last?.role === "assistant" && !String(last.content ?? "").trim() && !last.tool_calls) {
          history[history.length - 1] = { role: "assistant", content: reply };
        } else {
          history.push({ role: "assistant", content: reply });
        }
        logMessage(sessionId, "assistant", reply);
      }
    } catch {
      // The fallback below still applies; a failed retry must not lose the turn.
    }
  }

  // Both attempts came back blank. Say so, visibly: an honest sentence in the
  // transcript beats an empty bubble that reads as being ignored.
  if (!reply.trim()) {
    reply =
      "I could not produce an answer for this one — the reply ran out of room twice. " +
      "Try rephrasing, or raise ENIO_MAX_TOKENS.";
    handlers.onContent?.(reply);
    const last = history[history.length - 1];
    if (last?.role === "assistant" && !String(last.content ?? "").trim() && !last.tool_calls) {
      history[history.length - 1] = { role: "assistant", content: reply };
    } else {
      history.push({ role: "assistant", content: reply });
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
async function readAttachments(
  files: string[],
  notes: string[] = [],
): Promise<string> {
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
        // Surfaced to the user, never to the model. Telling the model its own
        // eyesight is limited is what makes it announce the limitation instead
        // of answering; the person who can act on it is the one reading the
        // window.
        if (reading.note) notes.push(reading.note);
        // Worded to avoid priming a refusal. An earlier version explained that
        // the model "cannot look at images, so the contents were extracted" --
        // and it replied "I am unable to view images" and asked the user to
        // type out what it said, with the answer sitting directly above it.
        // Naming the limitation is what invites it: the model completes the
        // pattern it was just handed. So the limitation goes unmentioned and
        // the extracted text is presented as ordinary content, which is all it
        // needs to be. Verified by asking the same question both ways --
        // "what does the attached text say" answered correctly while "what is
        // in this image" refused, against an identical prompt.
        blocks.push(
          `The user attached "${rel}". Its full text content, below, is ` +
            `available to you now and is what you should answer from. ` +
            `Answer questions about "${rel}" directly from it.\n\n` +
            `--- ${rel} ---\n${reading.text}\n--- end of ${rel} ---`,
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

  return `The user attached the following. Their contents are given in full below, and you can answer about them directly.\n\n${blocks.join("\n\n")}`;
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
    const result = await tool.run(args);

    // A tool may return a bare string or { text, widget }. The text is what
    // the model reads either way -- the widget never carries information the
    // text does not, so a client that cannot draw it loses nothing.
    const raw = typeof result === "string" ? result : result.text;
    if (typeof result !== "string" && result.widget) {
      handlers.onWidget?.(result.widget);
    }

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
