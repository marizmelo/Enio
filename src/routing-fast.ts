import { cosine } from "./memory/db.js";
import { embed, embedBatch } from "./memory/embed.js";
import { listCustomAgents } from "./custom-agents.js";
import { config } from "./config.js";

/**
 * The fast tier of the router: a decision, not a generation.
 *
 * Routing is a choice from a closed list, and the model router makes it by
 * writing JSON — a generation step doing a classification's job, at a model
 * call per turn (426ms median on the 4B) with no probability attached. This
 * tier makes the same choice by nearest example: every specialist has the
 * routing examples the prompt already carries plus its own description, all
 * embedded once; the request is embedded and scored against them; the gap
 * between the best and second-best specialist is the confidence. A wide gap
 * routes here in a few milliseconds on any CPU; a narrow one falls through
 * to the model, which is the only judge of an ambiguous request.
 *
 * The margin threshold is a measured number (scripts/route-bench.mjs), not a
 * feeling, and the tier ships off until that measurement holds the model
 * router's accuracy on the held-out set.
 */

export interface RoutingExample {
  text: string;
  specialist: string;
  /** Why this example exists, for the prompt's maintainers. */
  why?: string;
}

/**
 * One example per lesson, shared by the model router's prompt and this tier.
 * The model routes by pattern-matching these far more than the descriptions,
 * so a specialist with no example effectively does not exist for anything
 * its description's exact words don't cover -- the operator was unreachable
 * for "write a note for groceries" until it got one.
 */
export const ROUTING_EXAMPLES: RoutingExample[] = [
  { text: "what's new with the Vision Pro", specialist: "researcher" },
  { text: "why is my test failing", specialist: "coder" },
  {
    text: "analyze the numbers in sales.csv",
    specialist: "coder",
    why: "Data questions are file work: the coder reads the file and answers with Python through run_command. Without this, \"analyze this csv\" landed on the generalist, which has no file tools.",
  },
  {
    text: "build me a resume",
    specialist: "coder",
    why: "Documents are files, and write_file lives on the coder — routed to the researcher nothing landed on disk. A note-in-an-app stays with the operator.",
  },
  { text: "ask a bigger model to write this", specialist: "coder", why: "The handoff flow: composing a prompt-file is document work." },
  { text: "write a document about our launch plan", specialist: "coder" },
  { text: "what did I say I was working on", specialist: "librarian" },
  {
    text: "find my notes about the tax audit",
    specialist: "librarian",
    why: "Saved documents live in the library; \"my files\" without that framing stays with the coder's search_code.",
  },
  {
    text: "where is my tax return pdf on this computer",
    specialist: "librarian",
    why: "A name search is find_file, not the coder, whose search is scoped to the workspace.",
  },
  { text: "did Sam reply about the invoice", specialist: "mail" },
  { text: "write a note with my grocery list", specialist: "operator" },
  { text: "add lunch to my calendar for noon", specialist: "operator" },
  {
    text: "set an alarm for 7 tomorrow morning",
    specialist: "operator",
    why: "Alarms and reminders are Mac-app work; nothing in the description says so, and the generalist denied a capability Enio has.",
  },
  {
    text: "run my news-brief automation",
    specialist: "generalist",
    why: "\"pipeline\" reads as CI: routed to the coder, who has no run_pipeline tool and denied it exists.",
  },
  {
    text: "create an automation that emails me a summary",
    specialist: "generalist",
    why: "Authoring an automation is not a model act; the generalist's prompt knows where automations come from.",
  },
  { text: "explain monads to me", specialist: "generalist" },
];

/**
 * Exemplars for the tier only — never rendered into the model router's
 * prompt, so this list can be as long as nearest-example needs without
 * growing every turn's context. Eight or so per specialist, phrased the way
 * people actually ask; none appears in the held-out benchmark (a test holds
 * that). The first measurement, with only the prompt's sixteen examples and
 * the descriptions, scored 24 of 46: the planner had no example at all.
 */
export const FAST_EXEMPLARS: RoutingExample[] = [
  // researcher
  { text: "what happened in the news today", specialist: "researcher" },
  { text: "look up the population of Porto", specialist: "researcher" },
  { text: "what are people saying about the new iPhone", specialist: "researcher" },
  { text: "how do I get from Lisbon to Faro by train", specialist: "researcher" },
  { text: "who is the ceo of that company now", specialist: "researcher" },
  { text: "what's the latest version of node", specialist: "researcher" },
  { text: "is it going to rain tomorrow", specialist: "researcher" },
  { text: "find a recipe for lentil soup", specialist: "researcher" },
  { text: "what does the research say about intermittent fasting", specialist: "researcher" },
  // coder
  { text: "fix the bug in app.py", specialist: "coder" },
  { text: "run the tests and tell me what fails", specialist: "coder" },
  { text: "write a script that renames these files", specialist: "coder" },
  { text: "read config.yaml and change the port", specialist: "coder" },
  { text: "what's in the readme", specialist: "coder" },
  { text: "create a markdown document with the meeting notes", specialist: "coder" },
  { text: "plot the columns in data.csv", specialist: "coder" },
  { text: "where is the login function defined", specialist: "coder" },
  { text: "make me a spreadsheet of these numbers", specialist: "coder" },
  // librarian
  { text: "remember that I take my coffee black", specialist: "librarian" },
  { text: "what do you know about my job", specialist: "librarian" },
  { text: "what did we discuss last time about the move", specialist: "librarian" },
  { text: "search my library for the lease agreement", specialist: "librarian" },
  { text: "where is the file called budget2025 on my mac", specialist: "librarian" },
  { text: "do you remember my dog's name", specialist: "librarian" },
  { text: "keep in mind that I'm allergic to nuts", specialist: "librarian" },
  { text: "what have I told you about my parents", specialist: "librarian" },
  { text: "look in my saved documents for the warranty", specialist: "librarian" },
  // mail
  { text: "check my inbox for anything from the landlord", specialist: "mail" },
  { text: "did anyone email me about the meeting", specialist: "mail" },
  { text: "send an email to Ana saying I'll be late", specialist: "mail" },
  { text: "read me the last email from work", specialist: "mail" },
  { text: "is there a file in my google drive about the budget", specialist: "mail" },
  { text: "reply to that message and say yes", specialist: "mail" },
  { text: "any new mail this morning", specialist: "mail" },
  { text: "forward the receipt to accounting", specialist: "mail" },
  { text: "search my email for the flight confirmation", specialist: "mail" },
  // planner
  { text: "what's on my calendar today", specialist: "planner" },
  { text: "schedule a call with Marco on thursday at 3", specialist: "planner" },
  { text: "add buy milk to my todos", specialist: "planner" },
  { text: "what are my tasks for this week", specialist: "planner" },
  { text: "do I have anything on friday evening", specialist: "planner" },
  { text: "what's Ana's email address", specialist: "planner" },
  { text: "put the dentist appointment in my calendar", specialist: "planner" },
  { text: "mark the report todo as done", specialist: "planner" },
  { text: "when is my next meeting", specialist: "planner" },
  // operator
  { text: "open safari", specialist: "operator" },
  { text: "make a new note in the notes app", specialist: "operator" },
  { text: "take a screenshot", specialist: "operator" },
  { text: "play some music", specialist: "operator" },
  { text: "set a reminder to call mum at 6", specialist: "operator" },
  { text: "start a 10 minute timer", specialist: "operator" },
  { text: "mute the sound", specialist: "operator" },
  { text: "what's on my screen right now", specialist: "operator" },
  { text: "open the calculator and add these up", specialist: "operator" },
  // generalist
  { text: "what's the difference between a virus and a bacterium", specialist: "generalist" },
  { text: "help me decide between two apartments", specialist: "generalist" },
  { text: "explain compound interest simply", specialist: "generalist" },
  { text: "run the morning-brief automation", specialist: "generalist" },
  { text: "make an automation that checks my email every hour", specialist: "generalist" },
  { text: "give me three ideas for a birthday present", specialist: "generalist" },
  { text: "what time is it", specialist: "generalist" },
  { text: "tell me something interesting", specialist: "generalist" },
  { text: "is it a good idea to learn rust in 2026", specialist: "generalist" },
];

export interface Exemplar {
  text: string;
  specialist: string;
}

/** What the tier scores against: the shared examples, each specialist's
 *  description (written as the user would phrase the request), and custom
 *  agents' own example and description. */
export function routingExemplars(specialists: Array<{ name: string; description: string }>): Exemplar[] {
  const out: Exemplar[] = [];
  const names = new Set(specialists.map((s) => s.name));
  for (const e of [...ROUTING_EXAMPLES, ...FAST_EXEMPLARS]) {
    if (names.has(e.specialist)) out.push({ text: e.text, specialist: e.specialist });
  }
  for (const s of specialists) out.push({ text: s.description, specialist: s.name });
  for (const a of listCustomAgents()) {
    if (!names.has(a.name)) continue;
    if (a.example) out.push({ text: a.example, specialist: a.name });
  }
  return out;
}

export interface FastDecision {
  specialist: string;
  runnerUp: string | null;
  /** Best specialist's score minus the second best's: the confidence. */
  margin: number;
  scores: Record<string, number>;
  ms: number;
}

const vectorCache = new Map<string, Float32Array>();

/** Score a request vector against exemplar vectors: each specialist takes its
 *  best-matching exemplar, and the decision is the top score with the gap to
 *  the next specialist as its confidence. Pure, so the benchmark and the
 *  tests can drive it with vectors of their own. */
export function decide(
  request: Float32Array,
  exemplars: Array<Exemplar & { vector: Float32Array }>,
): Omit<FastDecision, "ms"> | null {
  const scores: Record<string, number> = {};
  for (const e of exemplars) {
    const s = cosine(request, e.vector);
    if (!(e.specialist in scores) || s > scores[e.specialist]!) scores[e.specialist] = s;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  const [best, second] = ranked;
  return {
    specialist: best![0],
    runnerUp: second?.[0] ?? null,
    margin: best![1] - (second?.[1] ?? 0),
    scores,
  };
}

/** Load the embedding model and the exemplar vectors ahead of the first
 *  request: the first route of a process otherwise pays ~800ms for what is
 *  4ms afterwards. Fire-and-forget at server boot; a failure here is the
 *  same as no embeddings, which the tier already treats as "the model
 *  routes". */
export function warmFastRouter(specialists: Array<{ name: string; description: string }>): void {
  if (!config.fastRoute) return;
  void fastRoute("warm up", specialists).catch(() => undefined);
}

/** The tier's verdict for a request, or null when embeddings are unavailable
 *  — in which case the model router is the router, as before. */
export async function fastRoute(
  input: string,
  specialists: Array<{ name: string; description: string }>,
): Promise<FastDecision | null> {
  const started = Date.now();
  const exemplars = routingExemplars(specialists);
  const missing = exemplars.filter((e) => !vectorCache.has(e.text));
  if (missing.length > 0) {
    const vecs = await embedBatch(missing.map((e) => e.text));
    missing.forEach((e, i) => {
      const v = vecs[i];
      if (v) vectorCache.set(e.text, v);
    });
  }
  const ready = exemplars
    .filter((e) => vectorCache.has(e.text))
    .map((e) => ({ ...e, vector: vectorCache.get(e.text)! }));
  if (ready.length === 0) return null;
  const request = await embed(input.slice(0, 500));
  if (!request) return null;
  const d = decide(request, ready);
  return d ? { ...d, ms: Date.now() - started } : null;
}
