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
 *
 * Authorship is stated because leaving it unstated is not neutral: the model
 * answered "who created you" from its weights as DeepGrove, who made the model
 * and had nothing to do with this.
 *
 * The model is now named rather than hidden. The assistant is not the model --
 * it has tools, memory and skills the weights know nothing about -- but hiding
 * what it runs on bought a different falsehood, "I am not based on any model",
 * which is worse than the implementation detail it was protecting.
 *
 * Every line here was settled by measurement, and the failure mode is
 * counterintuitive enough to be worth recording: whatever this prompt
 * emphasises, the model becomes. Naming DeepGrove more than once made it
 * answer "DeepGrove made me"; instructing it to say ${config.modelLabel} when
 * asked which model it uses made it introduce itself AS ${config.modelLabel}.
 * The wording that works states each fact once, plainly, and leans on nothing.
 * Repeated three times per question, this answers who made it and which
 * company did not 3/3, and names the model when asked. Re-measure before
 * re-wording -- reading better is not the test.
 */
const IDENTITY = `You are ${config.agentName}, a private assistant running on the user's own computer, with tools, memory and skills. You are an assistant that uses a language model, not the model itself.

${config.agentName} was made by ${config.agentAuthor}, working alone. No company was involved in making ${config.agentName}; asked which company is behind you, the answer is none.

The language model ${config.agentName} runs on is called ${config.modelLabel}.

The conversation so far appears above each new message. Earlier messages in it are yours to read, quote and answer from — when the user asks about something said earlier, look at the messages above and answer from them.`;

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
  /** Context carried after any folding, so a client can show how full it is. */
  onContext?(usage: { tokens: number; budget: number }): void;
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
 * Rough token count: Maple's tokeniser averages a shade under four characters
 * per token on English prose. Deliberately an estimate rather than a real
 * tokenise -- this runs on every message of every turn to decide what to fold,
 * and being 10% out moves the fold boundary by one message, while calling the
 * tokeniser would mean a round trip per message.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

function messageTokens(m: Message): number {
  return estimateTokens(String(m.content ?? "")) + 4;
}

/** What the model is currently carrying, for the caller to display. */
export function contextUsage(history: Message[]): { tokens: number; budget: number } {
  return {
    tokens: history.reduce((n, m) => n + messageTokens(m), 0),
    budget: config.contextBudget,
  };
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

  // Keep the newest messages that fit the token budget, not a fixed count of
  // them. Forty one-line exchanges and forty messages carrying a pasted file
  // differ by two orders of magnitude, and only the second one silently pushes
  // the model past where it can still recall what it was told.
  //
  // The system prompt is charged against the budget because the model pays for
  // it on every turn: a specialist prompt runs 600-1200 tokens, so a third or
  // more of the usable window is spoken for before the user says anything.
  const spent = system ? messageTokens(system) : 0;
  let room = Math.max(config.contextBudget - spent, Math.floor(config.contextBudget / 4));

  let keep = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = messageTokens(rest[i]!);
    // Always keep one message however large: that is the question just asked,
    // and summarising it would answer a paraphrase of the user instead of the
    // user.
    if (keep > 0 && (cost > room || keep >= config.historyWindow)) break;
    room -= cost;
    keep++;
  }

  if (keep >= rest.length) return history;

  const older = rest.slice(0, rest.length - keep);
  const recent = rest.slice(rest.length - keep);
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
 * Does this reply look like a repetition loop rather than an answer?
 *
 * The failure it catches, seen on "show my emails": seven tool iterations
 * produced nothing, the last attempt spent its whole budget thinking and came
 * back empty, and the no-think retry then filled 9,478 characters with "Let me
 * try read_file with the inbox file path." over and over -- which was shipped
 * to the user as the answer. Recovering from silence into a wall of the same
 * sentence is worse than the silence.
 *
 * Same shape the dictation worker guards against, and the same reasoning: real
 * writing has variety, a loop does not. Deliberately conservative -- it wants
 * several long sentences repeated verbatim and forming a large share of the
 * whole -- because a false positive discards a real answer, which is the one
 * outcome worse than printing a bad one.
 */
export function looksDegenerate(text: string): boolean {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 25);
  if (sentences.length < 8) return false;

  const counts = new Map<string, number>();
  for (const sentence of sentences) {
    counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
  }

  // How much of the answer is sentences it has already said.
  //
  // Measured on the real failure rather than assumed: the loop cycled through
  // six sentences twelve times each, so no single sentence was more than a
  // tenth of the text and a "most repeated sentence" test missed it entirely.
  // What gives it away is that 78% of the text was repeats and only 37 of 117
  // sentences were distinct. Prose and lists sit near zero here, because
  // writing the same full sentence twice is already unusual.
  let repeated = 0;
  for (const [, n] of counts) if (n >= 2) repeated += n;

  return repeated / sentences.length >= 0.5;
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
  // Either bound can fire: many small messages, or few enormous ones. Checking
  // only the count let a single pasted file sail past the budget unfolded.
  if (
    history.length - 1 > config.historyWindow ||
    contextUsage(history).tokens > config.contextBudget
  ) {
    const compacted = await compactHistory(history);
    history.splice(0, history.length, ...compacted);
  }

  handlers.onContext?.(contextUsage(history));

  const wireTools = activeTools.map(toWireTool);
  // What this route may execute, as opposed to what exists.
  const allowedToolNames = new Set(activeTools.map((t) => t.name));

  /** Run a batch of tool calls, recording each and appending its result to
   *  history — shared by the main loop and the no-think recovery below, so a
   *  recovered turn executes tools exactly the way a normal one does. */
  async function runToolCalls(calls: ToolCall[]): Promise<void> {
    for (const call of calls) {
      const toolStartedAt = Date.now();
      const output = await executeCall(call, registry, handlers, allowedToolNames);
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
  }
  const toolsUsed: string[] = [];
  let reply = "";
  // True when the turn ended with no content and no tool call -- the model
  // reasoned to the budget before it produced anything, tool call included.
  // Distinct from ending because it kept calling tools until iterations ran
  // out, which needs the opposite recovery.
  let thoughtToDeath = false;

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
      thoughtToDeath = !result.content.trim();
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

    await runToolCalls(result.toolCalls);

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
  // Remembered across the retry, because the fallback needs to say which
  // failure happened and by then `reply` is empty either way.
  let looped = looksDegenerate(reply);

  if (!reply.trim() || looped) {
    handlers.onNotice?.(
      looped
        ? "That answer got stuck repeating itself — trying again."
        : "The reply budget went entirely on thinking — answering again without it.",
    );
    // Drop the blank assistant turn the main loop left behind, so the retry --
    // which may now push its own assistant and tool messages -- does not build
    // on top of an empty one, and the transcript reads as a single clean turn.
    {
      const last = history[history.length - 1];
      if (last?.role === "assistant" && !String(last.content ?? "").trim() && !last.tool_calls) {
        history.pop();
      }
    }

    try {
      // The retry keeps its tools. The failure this recovers from is often a
      // turn that thought itself to death BEFORE calling the tool it needed --
      // "show my emails" reasoned to the ceiling and never reached
      // run_applescript. A retry with no tools could only narrate the action
      // it could not take ("I'll read your email content for you") and stop.
      // With thinking off it makes the call directly; each round after one
      // that calls tools is still no-think, so it cannot re-enter the loop it
      // just escaped.
      // Tools only when the model thought itself to death before reaching one.
      // If it ended still calling tools, more tool rounds repeat the failure,
      // so the retry gets none and is forced to answer from what it has.
      const retryTools = thoughtToDeath ? wireTools : [];
      const retryRounds = thoughtToDeath ? config.maxToolIterations : 1;
      let retry = { content: "", rawContent: "", reasoning: "", repaired: false, scavenged: false, toolCalls: [] as ToolCall[] };
      for (let r = 0; r < retryRounds; r++) {
        const retryStartedAt = Date.now();
        retry = await complete(
          history,
          retryTools,
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
        // No tools offered but a call emitted anyway is Maple hallucinating one;
        // executing it would be acting on a tool this recovery deliberately
        // withheld. Stop and take whatever content came with it.
        if (retry.toolCalls.length === 0 || retryTools.length === 0) break;
        history.push({
          role: "assistant",
          content: retry.content || null,
          tool_calls: retry.toolCalls,
        });
        await runToolCalls(retry.toolCalls);
      }

      if (looksDegenerate(retry.content)) looped = true;
      // A retry that loops is not an answer either. Rejecting it here is what
      // keeps the recovery from being worse than the failure.
      if (retry.content.trim() && !looksDegenerate(retry.content)) {
        reply = retry.content.trim();
        history.push({ role: "assistant", content: reply });
        logMessage(sessionId, "assistant", reply);
      }
    } catch {
      // The fallback below still applies; a failed retry must not lose the turn.
    }
  }

  // Both attempts failed. Say so, visibly: an honest sentence in the transcript
  // beats an empty bubble that reads as being ignored, and beats a page of the
  // model talking to itself.
  if (!reply.trim() || looksDegenerate(reply)) {
    // Two different failures, and saying which one is the difference between a
    // user retrying usefully and retrying blindly. Looping usually means the
    // question needs a tool that is not there; running out of room means the
    // budget was too small for the reasoning it wanted to do.
    reply = looped
      ? "I got stuck repeating myself instead of answering. That usually means " +
        "the question needs something I do not have a tool for — try rephrasing, " +
        "or ask me what I can do."
      : "I could not produce an answer for this one — the reply ran out of room twice. " +
        "Try rephrasing, or raise ENIO_MAX_TOKENS.";
    handlers.onContent?.(reply);
    const last = history[history.length - 1];
    if (last?.role === "assistant" && !String(last.content ?? "").trim() && !last.tool_calls) {
      history[history.length - 1] = { role: "assistant", content: reply };
    } else {
      history.push({ role: "assistant", content: reply });
    }
    logMessage(sessionId, "assistant", reply);
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

/**
 * The one allowed tool a misspelled name is unmistakably close to, or null.
 *
 * Deliberately strict. It requires a single candidate within a small edit
 * distance that scales with name length -- one or two characters on names this
 * long -- so "run_appletescript" resolves to run_applescript but "read" does
 * not silently become read_file. Two candidates equally close returns null:
 * correcting toward the wrong tool is worse than reporting the miss and
 * letting the model see the real list.
 */
function nearestAllowedTool(name: string, allowed: Set<string>): string | null {
  // Compared lower-case: the model varies capitalisation freely and a case
  // difference is never a different tool. Seen in the wild as
  // "run_appLEScriпт" -- wrong case and two Cyrillic homoglyphs -- which is
  // two edits from run_applescript once case stops counting, and fifteen
  // before.
  const target = name.toLowerCase();
  const budget = name.length <= 6 ? 1 : 2;
  let best: string | null = null;
  let bestDistance = Infinity;
  let tie = false;
  for (const candidate of allowed) {
    const d = editDistance(target, candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
      tie = false;
    } else if (d === bestDistance) {
      tie = true;
    }
  }
  return best !== null && bestDistance <= budget && !tie ? best : null;
}

/** Levenshtein distance, iterative with a single row. Small inputs, so the
 *  quadratic cost is nothing and the simplicity is worth more. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j]!;
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j]!, row[j - 1]!);
      prev = temp;
    }
  }
  return row[b.length]!;
}

async function executeCall(
  call: ToolCall,
  registry: Registry,
  handlers: TurnHandlers,
  /**
   * The tools this turn is actually allowed to run.
   *
   * Looking the name up in the full registry was a hole in the thing the
   * specialists exist for: the generalist is offered five tools and could
   * execute any of thirteen, run_command included, purely by emitting a call
   * for it. The model only has to hallucinate a name it saw in an error
   * message -- and the error message used to list every tool in the registry,
   * which is where it saw them.
   */
  allowed: Set<string>,
): Promise<string> {
  // A small model fat-fingers the tool name itself, separately from
  // hallucinating one: it wrote "run_appletescript" for run_applescript, one
  // transposition off, having just used the skill to author a correct script.
  // Rejecting that wastes the whole turn over a typo. So an unknown name is
  // matched to the single allowed tool it is unmistakably close to -- and only
  // a single one, because correcting toward the wrong tool is worse than not
  // correcting at all.
  const resolvedName = allowed.has(call.function.name)
    ? call.function.name
    : nearestAllowedTool(call.function.name, allowed);
  const tool = resolvedName ? registry.byName.get(resolvedName) : undefined;

  if (!tool) {
    // Hallucinated tool names are common with small models. Telling the model
    // exactly what it has recovers the turn far more often than a bare error --
    // but only this route's tools, or the suggestion is one it cannot take.
    const available = [...allowed].join(", ");
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
