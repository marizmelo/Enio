import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { config } from "./config.js";
import { complete } from "./model.js";
import { contextBudget } from "./model-settings.js";
import { neutralizeControlTokens } from "./sanitize.js";
import type { Message } from "./types.js";

/**
 * The managed note store — the first "section as an app".
 *
 * Notes live in workspace/.notes/, a dotfolder every listing walker already
 * skips, so the collection is invisible to @mentions and file dialogs for
 * free. The folder is managed by CONVENTION, not enforcement: enio's
 * processes are its only writers (the canvas saves, the agent edits a
 * pinned note, transforms splice the buffer), external editors stay out
 * because the UI never reveals the path, and export is "Save a copy". That
 * convention is what makes quote-anchored comments reliable — anchors
 * relocate on every read, and nothing outside enio churns the text under
 * them.
 *
 * Two shapes of model call live here, both the revise.ts species — bounded
 * transformations, never agent turns, because "tighten this selection" has
 * one right answer and a 4B finds it far more reliably than it plans:
 * selection verbs (selection in, replacement out, previewed before it
 * lands) and comment-thread replies (quoted passage + thread in, one
 * comment out).
 *
 * SANITIZE, load-bearing: everything read from disk — selection, context
 * windows, quotes, stored thread messages — is untrusted file content and
 * goes through neutralizeControlTokens before it enters a prompt. A note
 * containing a literal <|im_start|> must read as text, not as a role
 * boundary. Only the instruction the user typed this second is trusted.
 * Do not "clean this up" into fewer calls at the edge; the edge is the
 * point.
 */

export interface NoteMeta {
  name: string;
  title: string;
  updatedAt: number;
  size: number;
}

function notesRoot(): string {
  const dir = join(config.workspace, ".notes");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Flat names only: "x.md", no paths, no dotfiles. Deliberately NOT
 * safePath — a project mount named ".notes" must not hijack the store, and
 * notes never live in a project's out dir.
 */
export function resolveNote(name: string): string | null {
  if (!name || name !== basename(name) || name.startsWith(".") || !name.endsWith(".md")) {
    return null;
  }
  const root = notesRoot();
  const full = resolve(root, name);
  if (full !== join(root, name) || !full.startsWith(root + sep)) return null;
  return full;
}

const titleOf = (content: string, name: string): string =>
  /^#\s+(.+)$/m.exec(content)?.[1]?.trim() || name.replace(/\.md$/, "");

export function listNotes(): NoteMeta[] {
  const root = notesRoot();
  const notes: NoteMeta[] = [];
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
    try {
      const full = join(root, entry);
      const stat = statSync(full);
      if (!stat.isFile()) continue;
      notes.push({
        name: entry,
        title: titleOf(readFileSync(full, "utf8"), entry),
        updatedAt: stat.mtimeMs,
        size: stat.size,
      });
    } catch {
      // A note that vanished mid-list is not worth failing the list over.
    }
  }
  return notes.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createNote(title?: string): NoteMeta {
  const clean = (title ?? "").trim() || "Untitled note";
  const slug =
    clean
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled-note";
  const root = notesRoot();
  let name = `${slug}.md`;
  for (let n = 2; existsSync(join(root, name)); n++) name = `${slug}-${n}.md`;
  const full = join(root, name);
  writeFileSync(full, `# ${clean}\n\n`, "utf8");
  const stat = statSync(full);
  return { name, title: clean, updatedAt: stat.mtimeMs, size: stat.size };
}

export function readNote(name: string): { meta: NoteMeta; content: string } | null {
  const full = resolveNote(name);
  if (!full || !existsSync(full)) return null;
  const content = readFileSync(full, "utf8");
  const stat = statSync(full);
  return {
    meta: { name, title: titleOf(content, name), updatedAt: stat.mtimeMs, size: stat.size },
    content,
  };
}

/* ---------- comments ---------------------------------------------------- */

export interface ThreadMessage {
  role: "user" | "ai";
  text: string;
  at: string;
}

export interface Thread {
  id: string;
  quote: string;
  prefix: string;
  suffix: string;
  resolved: boolean;
  createdAt: string;
  messages: ThreadMessage[];
}

interface SidecarData {
  version: 1;
  threads: Thread[];
}

const sidecarPath = (noteFull: string): string => `${noteFull}.comments.json`;

/**
 * A damaged sidecar degrades loudly: the threads read as empty and
 * `damaged` says so, and the first WRITE moves the unreadable file aside
 * with a stamp rather than deleting it — comments are authored content,
 * and authored content is never silently discarded.
 */
export function loadThreads(name: string): { threads: Thread[]; damaged: boolean } {
  const full = resolveNote(name);
  if (!full) return { threads: [], damaged: false };
  const sidecar = sidecarPath(full);
  if (!existsSync(sidecar)) return { threads: [], damaged: false };
  try {
    const data = JSON.parse(readFileSync(sidecar, "utf8")) as SidecarData;
    if (!Array.isArray(data.threads)) throw new Error("no threads array");
    return { threads: data.threads, damaged: false };
  } catch {
    return { threads: [], damaged: true };
  }
}

function saveThreads(name: string, threads: Thread[]): void {
  const full = resolveNote(name);
  if (!full) throw new Error(`Not a note: ${name}`);
  const sidecar = sidecarPath(full);
  if (existsSync(sidecar) && loadThreads(name).damaged) {
    renameSync(sidecar, `${sidecar}.damaged-${Date.now().toString(36)}`);
  }
  writeFileSync(
    sidecar,
    JSON.stringify({ version: 1, threads } satisfies SidecarData, null, 2) + "\n",
    "utf8",
  );
}

export interface AnchorHit {
  start: number;
  end: number;
  exact: boolean;
}

/**
 * Where a thread's quote lives in the current text, or null. The ladder:
 * exact-and-unique, exact disambiguated by surrounding context, then a
 * whitespace-normalized match for text that merely reflowed. Computed on
 * every read and never stored, so restoring deleted text un-orphans a
 * thread with no bookkeeping at all.
 */
export function locateQuote(
  text: string,
  quote: string,
  prefix: string,
  suffix: string,
): AnchorHit | null {
  if (!quote) return null;

  const occurrences: number[] = [];
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
    occurrences.push(at);
    if (occurrences.length > 50) break;
  }
  if (occurrences.length === 1) {
    return { start: occurrences[0]!, end: occurrences[0]! + quote.length, exact: true };
  }
  if (occurrences.length > 1) {
    let best = occurrences[0]!;
    let bestScore = -1;
    for (const at of occurrences) {
      const before = text.slice(Math.max(0, at - prefix.length), at);
      const after = text.slice(at + quote.length, at + quote.length + suffix.length);
      let score = 0;
      for (let i = 0; i < before.length && i < prefix.length; i++) {
        if (before[before.length - 1 - i] === prefix[prefix.length - 1 - i]) score++;
      }
      for (let i = 0; i < after.length && i < suffix.length; i++) {
        if (after[i] === suffix[i]) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = at;
      }
    }
    return { start: best, end: best + quote.length, exact: true };
  }

  // Reflowed text: match with whitespace collapsed, then map indices back.
  // The map records, for every character of the collapsed text, its index
  // in the original — so a hit in collapsed space translates exactly.
  const map: number[] = [];
  let collapsed = "";
  let lastWasSpace = true;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]!)) {
      if (!lastWasSpace) {
        collapsed += " ";
        map.push(i);
        lastWasSpace = true;
      }
    } else {
      collapsed += text[i]!;
      map.push(i);
      lastWasSpace = false;
    }
  }
  const flatQuote = quote.replace(/\s+/g, " ").trim();
  if (!flatQuote) return null;
  const at = collapsed.indexOf(flatQuote);
  if (at === -1) return null;
  const start = map[at]!;
  const endIdx = at + flatQuote.length - 1;
  const end = map[endIdx]! + 1;
  return { start, end, exact: false };
}

/* ---------- the model calls --------------------------------------------- */

export const NOTE_VERBS = ["tighten", "expand", "rewrite", "continue"] as const;
export type NoteVerb = (typeof NOTE_VERBS)[number];

export interface TransformInput {
  text: string;
  start: number;
  end: number;
  verb: string;
  instruction?: string;
}

export interface TransformResult {
  ok: boolean;
  replacement?: string;
  reason?: string;
}

const TAIL = "Reply with ONLY the replacement text — no preamble, no explanation, no code fences.";
const VERB_SYSTEM: Record<NoteVerb, string> = {
  tighten:
    "You tighten prose. Rewrite the selection to say the same thing in fewer words. " +
    `Keep the meaning, the tone, and the formatting — markdown stays markdown. Do not add anything new. ${TAIL}`,
  expand:
    "You expand prose. Rewrite the selection with more detail and development, in the same tone " +
    `and formatting. Build only on what the selection and the surrounding text already say — do not invent facts. ${TAIL}`,
  rewrite:
    "You rewrite prose to an instruction. Apply the instruction to the selection and nothing else — " +
    `leave everything the instruction does not mention as it is, including formatting. ${TAIL}`,
  continue:
    "You continue a document. Write the next passage that naturally follows the text before the " +
    "cursor, matching its tone, formatting, and topic. Do not repeat what is already written. " +
    "Reply with ONLY the text to insert — no preamble, no code fences.",
};

const stripOuterFence = (text: string): string => {
  const fenced = /^```[a-z]*\n([\s\S]*)\n```$/.exec(text.trim());
  return fenced ? fenced[1]!.trim() : text.trim();
};

/**
 * A selection verb: selection in, replacement out, nothing written — the
 * preview in the canvas is where it lands, behind an Accept. Greedy for
 * revise's reason: "make this shorter" has one right answer, and sampling
 * only adds variance to a structured edit.
 */
export async function transformSelection(input: TransformInput): Promise<TransformResult> {
  const { text } = input;
  let { start, end } = input;
  const verb = input.verb as NoteVerb;
  const instruction = (input.instruction ?? "").trim();

  if (!NOTE_VERBS.includes(verb)) {
    return { ok: false, reason: "That is not one of the editing actions." };
  }
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > text.length ||
    start > end
  ) {
    return { ok: false, reason: "The selection does not match the text." };
  }
  if (verb === "continue") {
    // A continue with a range collapses to a cursor at the range's end.
    start = end;
  } else if (start === end) {
    return { ok: false, reason: "Select some text first." };
  }
  if (verb === "rewrite" && !instruction) {
    return { ok: false, reason: "Say how to rewrite it." };
  }

  const charBudget = contextBudget() * 3;
  const selection = text.slice(start, end);
  if (selection.length > Math.floor(charBudget / 2)) {
    return { ok: false, reason: "That selection is too long to transform — select less." };
  }
  const window = Math.floor(charBudget / 4);
  const before = neutralizeControlTokens(text.slice(Math.max(0, start - window), start));
  const after = neutralizeControlTokens(text.slice(end, end + window));
  const safeSelection = neutralizeControlTokens(selection);

  const user =
    verb === "continue"
      ? `Text before the cursor:\n${before}\n\nText after the cursor:\n${after}`
      : `Text before the selection:\n${before}\n\nSelection:\n${safeSelection}\n\n` +
        `Text after the selection:\n${after}` +
        (verb === "rewrite" ? `\n\nInstruction: ${instruction}` : "");

  const messages: Message[] = [
    { role: "system", content: VERB_SYSTEM[verb] },
    { role: "user", content: user },
  ];

  try {
    const result = await complete(messages, [], {}, undefined, { temperature: 0 });
    const replacement = stripOuterFence(result.content);
    if (!replacement) return { ok: false, reason: "The model returned nothing." };
    return { ok: true, replacement };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

async function aiReply(thread: Thread, noteText: string): Promise<string | null> {
  const hit = locateQuote(noteText, thread.quote, thread.prefix, thread.suffix);
  const window = Math.floor((contextBudget() * 3) / 4);
  const around = hit
    ? noteText.slice(Math.max(0, hit.start - window), hit.end + window)
    : thread.prefix + thread.quote + thread.suffix;

  const lines = thread.messages
    .map((m) => `${m.role === "ai" ? "AI" : "User"}: ${neutralizeControlTokens(m.text)}`)
    .join("\n");

  const messages: Message[] = [
    {
      role: "system",
      content:
        "You are discussing a passage of the user's note in a comment thread. Reply to the " +
        "latest message briefly and concretely, grounded in the quoted passage and its " +
        "surrounding text. If there is no question yet, say what you notice about the passage. " +
        "Reply with ONLY the comment text, no preamble.",
    },
    {
      role: "user",
      content:
        `The passage and its surroundings:\n${neutralizeControlTokens(around)}\n\n` +
        `The quoted passage under discussion:\n${neutralizeControlTokens(thread.quote)}\n\n` +
        `The thread so far:\n${lines || "(no messages yet)"}`,
    },
  ];

  try {
    const result = await complete(messages, [], {}, undefined, { temperature: 0 });
    const reply = stripOuterFence(result.content);
    return reply || null;
  } catch {
    return null;
  }
}

export interface ThreadResult {
  ok: boolean;
  thread?: Thread;
  reason?: string;
}

const QUOTE_CAP = 2000;

export async function createThread(
  name: string,
  args: { quote: string; prefix?: string; suffix?: string; question?: string },
): Promise<ThreadResult> {
  const note = readNote(name);
  if (!note) return { ok: false, reason: `No such note: ${name}` };
  const quote = args.quote ?? "";
  if (!quote.trim()) return { ok: false, reason: "Select the text to discuss first." };
  if (quote.length > QUOTE_CAP) {
    return { ok: false, reason: "That selection is too long to discuss — select less." };
  }

  const thread: Thread = {
    id: `c-${randomUUID()}`,
    quote,
    prefix: (args.prefix ?? "").slice(-40),
    suffix: (args.suffix ?? "").slice(0, 40),
    resolved: false,
    createdAt: new Date().toISOString(),
    messages: [],
  };
  const question = (args.question ?? "").trim();
  if (question) {
    thread.messages.push({ role: "user", text: question, at: new Date().toISOString() });
  }

  const reply = await aiReply(thread, note.content);
  if (reply) {
    thread.messages.push({ role: "ai", text: reply, at: new Date().toISOString() });
  }

  const { threads } = loadThreads(name);
  threads.push(thread);
  saveThreads(name, threads);
  return { ok: true, thread };
}

export async function replyThread(
  name: string,
  threadId: string,
  text: string,
): Promise<ThreadResult> {
  const clean = (text ?? "").trim();
  if (!clean) return { ok: false, reason: "Say something first." };
  const note = readNote(name);
  if (!note) return { ok: false, reason: `No such note: ${name}` };
  const { threads } = loadThreads(name);
  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return { ok: false, reason: "That thread is gone." };

  thread.messages.push({ role: "user", text: clean, at: new Date().toISOString() });
  const reply = await aiReply(thread, note.content);
  if (reply) {
    thread.messages.push({ role: "ai", text: reply, at: new Date().toISOString() });
  }
  // The user's message persists even when the model had nothing to say —
  // the thread stays honest about what happened.
  saveThreads(name, threads);
  return { ok: true, thread };
}

export function setThreadResolved(
  name: string,
  threadId: string,
  resolved: boolean,
): ThreadResult {
  const { threads } = loadThreads(name);
  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return { ok: false, reason: "That thread is gone." };
  thread.resolved = resolved;
  saveThreads(name, threads);
  return { ok: true, thread };
}

export function deleteThread(name: string, threadId: string): { ok: boolean; reason?: string } {
  const { threads } = loadThreads(name);
  const next = threads.filter((t) => t.id !== threadId);
  if (next.length === threads.length) return { ok: false, reason: "That thread is gone." };
  saveThreads(name, next);
  return { ok: true };
}
