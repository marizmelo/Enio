import { embed } from "./memory/embed.js";
import { nearestLabel, embedMissing } from "./nearest.js";
import { listCustomAgents } from "./custom-agents.js";
import { config } from "./config.js";
import { anyAccountWith } from "./accounts.js";
import { desktopEnabled } from "./tools/desktop.js";

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
 * feeling: the tier ships on at the margin where the measurement held the
 * model router's accuracy on the held-out set. The scoring itself is in
 * nearest.ts, shared with the reply-mood label.
 */

export interface RoutingExample {
  text: string;
  specialist: string;
  /** Why this example exists, for the prompt's maintainers. */
  why?: string;
  /** A change to the calendar or the todo list: see calendarChanger. */
  calendarChange?: true;
}

/**
 * Who a calendar or todo change goes to: whoever holds the tool for it.
 *
 * Two specialists can make one. The planner calls add_event or add_todo on a
 * connected account, which exists only with the calendar write grant; the
 * operator proposes a plan in the Calendar or Reminders app, which exists
 * only with desktop control on. An example that names one of them for
 * everybody is wrong wherever that one holds nothing: "add lunch to my
 * calendar" stayed an operator example after the planner arrived, so with an
 * account connected a change was routed past the one tool call that makes it
 * and into an AppleScript plan — and naming the planner instead would send
 * someone with no account to a specialist holding nothing but read_skill.
 * The conditions are the tools' own registration gates, read at route time,
 * so the route follows the tool rather than a second opinion about it.
 * With neither, the planner: its turn ends on the notice that says how to
 * connect an account.
 */
export function calendarChanger(): "planner" | "operator" {
  return !anyAccountWith("calendar.write") && desktopEnabled() ? "operator" : "planner";
}

/** The examples as this install should read them, each with the specialist
 *  it teaches. Both tiers take their table from here, so they cannot
 *  disagree about who a calendar change belongs to. */
export function resolveExamples(table: RoutingExample[]): Exemplar[] {
  const changer = calendarChanger();
  return table.map((e) => ({ text: e.text, specialist: e.calendarChange ? changer : e.specialist }));
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
    text: "sort the files in the exports folder into subfolders by year",
    specialist: "coder",
    why: "Bulk file work is run_command in a folder. \"control Finder\" in the operator's description took renames and moves to a specialist with no file tools.",
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
    text: "remember that I take my coffee black",
    specialist: "librarian",
    why: "Storing had no example, only retrieving: \"remind yourself that...\" went to the generalist, which has no remember tool.",
  },
  {
    text: "always answer me in bullet points",
    specialist: "librarian",
    why: "A how-to-behave instruction is set_preference. Unexampled it read as conversation and was agreed to, then forgotten.",
  },
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
  {
    text: "what did the insurance company send me",
    specialist: "mail",
    why: "A named sender with no word \"email\": beside the librarian's \"what did I say\" it read as memory.",
  },
  {
    text: "reply to Marco and say yes",
    specialist: "mail",
    why: "Sending had no example, only reading, so a reply to a person read as an action in a Mac app.",
  },
  {
    text: "what's on my calendar today",
    specialist: "planner",
    why: "Reading the calendar is the planner's on every install, so it keeps one example when the changes below resolve to the operator.",
  },
  {
    text: "add lunch to my calendar for noon",
    specialist: "planner",
    calendarChange: true,
    why: "The planner had no example here at all, and this one named the operator from before the planner existed: nearly every calendar or todo change the model routed went to the operator.",
  },
  { text: "add buy milk to my todos", specialist: "planner", calendarChange: true },
  {
    text: "move my 3pm meeting to friday",
    specialist: "planner",
    calendarChange: true,
    why: "No word \"calendar\" in it. Rescheduling is said with move, push and shift, which otherwise read as moving a thing on the Mac.",
  },
  { text: "write a note with my grocery list", specialist: "operator" },
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
  {
    text: "why do cats purr",
    specialist: "generalist",
    why: "A timeless question needs no lookup. With only \"explain\" exampled, a plain why went to the researcher and paid for a web search.",
  },
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
  { text: "schedule a call with Marco on thursday at 3", specialist: "planner", calendarChange: true },
  { text: "what are my tasks for this week", specialist: "planner" },
  { text: "do I have anything on friday evening", specialist: "planner" },
  { text: "what's Ana's email address", specialist: "planner" },
  { text: "put the dentist appointment in my calendar", specialist: "planner", calendarChange: true },
  { text: "mark the report todo as done", specialist: "planner", calendarChange: true },
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
  // Opening an app is the operator's whatever the app is about: without
  // this, an app named after another specialist's subject went to that
  // specialist ("open the calendar app" to the planner, clear of the margin).
  { text: "open the mail app", specialist: "operator" },
  // The only exemplar that says Shortcut. "run my ... shortcut" otherwise sat
  // nearest "run my news-brief automation" and went to the generalist.
  { text: "run the Shortcut that turns on focus mode", specialist: "operator" },
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
  // Advice about a hobby is not a request to operate it: "a good way to
  // learn the guitar" was nearest "play some music", by 0.097.
  { text: "what's a good way to get better at chess", specialist: "generalist" },
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
  for (const e of resolveExamples([...ROUTING_EXAMPLES, ...FAST_EXEMPLARS])) {
    if (names.has(e.specialist)) out.push(e);
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
  const n = nearestLabel(
    request,
    exemplars.map((e) => ({ text: e.text, label: e.specialist, vector: e.vector })),
  );
  if (!n) return null;
  return { specialist: n.label, runnerUp: n.runnerUp, margin: n.margin, scores: n.scores };
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
  await embedMissing(vectorCache, exemplars.map((e) => e.text));
  const ready = exemplars
    .filter((e) => vectorCache.has(e.text))
    .map((e) => ({ ...e, vector: vectorCache.get(e.text)! }));
  if (ready.length === 0) return null;
  const request = await embed(input.slice(0, 500));
  if (!request) return null;
  const d = decide(request, ready);
  return d ? { ...d, ms: Date.now() - started } : null;
}
