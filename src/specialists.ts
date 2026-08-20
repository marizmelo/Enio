import { z } from "zod";
import { complete } from "./model.js";
import { activeProject } from "./project.js";
import type { Registry } from "./tools/index.js";
import type { Message, ToolDef } from "./types.js";

/**
 * Specialists: one model, several narrow roles.
 *
 * The reason this exists is the tool budget, not org-chart aesthetics. Maple
 * picks tools poorly once it can see more than a handful, and the ceiling is
 * around 16. Routing to a specialist that exposes 4-5 *disjoint, coherent*
 * tools is the single largest improvement available to small-model tool
 * accuracy — larger than any prompt tweak.
 *
 * Depth is kept at exactly one hop. Router -> specialist -> answer. Each
 * additional hand-off compounds error, and with ~1B active parameters that
 * compounds fast. There is deliberately no agent-to-agent conversation.
 *
 * Because every specialist is the same weights with a different system prompt
 * and tool subset, this costs one extra short model call and nothing else.
 */

export interface Specialist {
  name: string;
  /** Shown to the router. Write it as the user would describe their request. */
  description: string;
  systemPrompt: string;
  /** Built-in tools this specialist may use. MCP tools are matched by prefix. */
  tools: string[];
  /** MCP servers whose tools this specialist may use. */
  mcpServers?: string[];
}

/**
 * read_skill appears in every specialist. Skills are know-how rather than
 * capability, so any role can need them, and the slot is cheap: one tool
 * covers every installed skill.
 */
export const SPECIALISTS: Specialist[] = [
  {
    name: "researcher",
    // "announcements and events" is there for things like WWDC: developer
    // words in a what-happened question routed to the coder, which has no web
    // access and could only guess.
    description:
      "Questions about the outside world: news, current events, announcements, documentation, or anything needing a web lookup.",
    systemPrompt:
      `You research things and report what you find.\n\n` +
      // Memory first, then the web -- and stated in this order because the
      // researcher was re-searching facts the user had saved from an answer
      // three messages up. The block below the role carries what is known.
      `If the Known facts below, or an earlier answer in this conversation, already ` +
      `say what the user is asking, answer from that and say it is something you ` +
      `already knew — do not search again for it. Otherwise ` +
      `start with web_search. It returns the ranked list AND the text of ` +
      `the top pages, so one call is usually everything you need. Never guess a ` +
      `URL — a guessed address is a 404, and the search is there so you do not ` +
      `have to. Use browse when you need to follow a trail (it keeps the ` +
      `session: use link: <number> from the list it prints), and web_fetch for ` +
      `one more page you already have the address of.\n\n` +
      // No links in the answer, on purpose. The Sources footer under every
      // reply is built by the harness from what the tools actually returned
      // -- evidence the model saw, which it cannot invent. Inline links were
      // the model's own account of the same thing, and a model asked to link
      // each claim to its page will mint a page when it has none: a
      // from-memory answer carried a plausible CNN path that 404s. Two
      // accounts of provenance, one of which can lie, is worse than one that
      // cannot. So the model names things; the footer links them.
      `Answer from what the pages say, not from the search snippets. Do not ` +
      `write links, URLs or a Source line — the pages you read are listed under ` +
      `your answer automatically. Name the thing plainly instead: "the JBL Flip 7 ` +
      `is £120".\n\n` +
      `If the sources disagree, say so rather than picking one silently. If you ` +
      `could not find something, say that plainly — a confident wrong answer is ` +
      `worse than an admission.`,
    // weather lives here as well as on the generalist because this is where
    // the router actually sends "what is it like outside" -- it reads as a
    // question about the world, which is exactly this specialist's description.
    // Overlap is the lesser evil: a tool on two specialists costs a slot, a
    // tool on the wrong one costs the answer.
    tools: ["web_search", "web_fetch", "browse", "recall", "weather", "read_skill"],
  },
  {
    name: "coder",
    description:
      "Reading, writing, running, debugging or explaining code and files in the working folders.",
    systemPrompt:
      `You work with files in the user's working folders — code, and the ` +
      `documents they ask you to write.\n\n` +
      // The narrate-instead-of-act failure in its coder form: asked to
      // create an app, the model put 7,000 characters of code in the reply
      // and wrote nothing. Stated as the first rule, concretely.
      `Code goes in files, never in the reply. When asked to create or build ` +
      `something, call write_file for each file — full path, full contents; it ` +
      `creates any missing folders itself, so you never need mkdir — and then ` +
      `answer with the list of paths you wrote. A reply that contains the code ` +
      `instead of writing it has done nothing.\n\n` +
      // Documents were the silent failure here: asked for a resume, a model
      // whose prompt only said "you work with code" wrote prose into the
      // reply and never called write_file -- so nothing landed on disk and
      // the canvas had nothing to open. The tile's own "save it as a
      // markdown file" was not enough; the instruction has to be where the
      // turn's whole framing is.
      `When the request is for a document — a resume, letter, report, notes, ` +
      `a plan — write it and SAVE it with write_file as markdown, then say ` +
      `where it went. Producing the text in the reply alone is not doing the ` +
      `task: the user asked for a document, and a document is a file.\n\n` +
      // The look-before-guess and verify rules are stated here AND enforced
      // by the harness (search seed, verify-after-write), because at this
      // model size the prompt alone measurably did not produce either.
      `Look before you edit: use the search results already shown, or ` +
      `search_code, then read the file rather than assuming its contents. ` +
      `Use paths exactly as printed. To change an existing file, call ` +
      `edit_file with old_string copied exactly from what read_file printed ` +
      `— without the line numbers — and new_string in its place; use ` +
      `write_file for a new file, a whole document, or a file that read_file ` +
      `showed as empty. Code you type in the reply reaches no file: a file ` +
      `changes only when write_file or edit_file is called. To see what a ` +
      `folder holds, run_command ls <folder>. After a change, run the relevant ` +
      `test or build command to check it. Report what you actually observed, ` +
      `including failures — do not describe an intended outcome as if it ` +
      `happened.\n\n` +
      `Everything is scoped to the granted folders. Paths outside them are ` +
      `refused, which is expected, not a bug to work around.`,
    // read_image left to generalist and operator (both keep it): the swap
    // that fits search_code under the six-tool ceiling. Image questions
    // route to specialists that still hold the tool.
    tools: ["read_file", "edit_file", "write_file", "run_command", "search_code", "read_skill"],
    mcpServers: ["filesystem", "git", "github"],
  },
  {
    name: "librarian",
    description:
      "Anything about the user themselves, their preferences, earlier conversations, the documents in their library, or finding a file on this computer by name.",
    systemPrompt:
      `You manage what is known about the user.\n\n` +
      `Call recall before answering questions about them — do not guess from ` +
      `the conversation alone. When they state something durable about ` +
      `themselves, store it with remember, one self-contained fact per call. ` +
      `When they state how they want you to behave, use set_preference instead: ` +
      `preferences shape every future conversation, facts only inform them.\n\n` +
      `recall covers what came up in conversation; library_search covers the ` +
      `documents they filed in their library folders. When they ask about ` +
      `their saved documents, notes, papers or records, use library_search ` +
      `and quote what it returns, naming the file it came from.\n\n` +
      `If memory holds nothing relevant, say so rather than inventing continuity.\n\n` +
      `find_file locates files anywhere on this computer by name — locations ` +
      `only, never contents. Report the paths it returns; to read one, tell ` +
      `the user to attach it to the conversation.`,
    tools: ["recall", "remember", "set_preference", "library_search", "find_file", "read_skill"],
  },
  {
    name: "mail",
    description:
      "Anything about email: finding a message, catching up on the inbox, summarising a thread, or drafting and sending a reply.",
    systemPrompt:
      `You handle the user's email.\n\n` +
      `Search before you answer — never guess what is in the inbox. search_email ` +
      `returns headers and ids; read_email opens one in full. Reading is ` +
      `strictly read-only: nothing you do marks a message read or moves it.\n\n` +
      `Before drafting a reply, read the message you are replying to. Check who ` +
      `it is actually from — the display name is not the address, and a reply ` +
      `sent to the wrong person cannot be recalled.\n\n` +
      `Show the user any message you intend to send and get agreement first.`,
    tools: ["search_email", "read_email", "send_email", "read_skill"],
  },
  {
    name: "operator",
    // Leads with the concrete verbs people actually say -- "write a note",
    // "add an event" -- because the router pattern-matches wording, and
    // "doing something on the machine" matched nothing anyone says. Measured:
    // "write a note for groceries" routed to the generalist, which cannot do
    // it, and answered with prose about the note it was not creating.
    description:
      "Creating or changing things in Mac apps: open an app, write a note, add a calendar event, set a reminder, check the screen, control Finder or Music, run a Shortcut.",
    systemPrompt:
      `You operate the user's Mac.\n\n` +
      `open_app opens or fronts an app by name; that alone needs no plan. ` +
      `The machine changes between messages — the user opens and closes ` +
      `things themselves — so never say an app is open or closed from ` +
      `memory. Asked to open something, call open_app even if it seems ` +
      `already open; asked whether something is open, check running_apps. ` +
      `For reading Mail, Calendar, Notes, Reminders or Finder, use mac_recipe ` +
      `and pick the recipe by name. Do not write AppleScript for these — the ` +
      `recipes are already correct, and a script you compose will not be. ` +
      `take_screenshot shows you what is on screen.\n\n` +
      `To do something *in* an app: read menu_items for that app, then call ` +
      `propose_plan. At most two reads before proposing, and only about the ` +
      `app you are acting on — the user's other data is not part of the job. ` +
      `Steps click, press or type by name, copying each name exactly as ` +
      `menu_items or window_controls printed it. A name you copied works; one ` +
      `you remembered does not.\n\n` +
      `When nothing else fits, a step may carry AppleScript instead. You are ` +
      `not able to run any of it — propose_plan writes it down for the user to ` +
      `approve, and that is the correct outcome, not a failure. Never describe ` +
      `a step in your reply instead of proposing it: a description does nothing.\n\n` +
      `Once the plan is proposed, reply in a sentence and stop. Do not narrate ` +
      `what you are checking or about to do — the user sees the tools run and ` +
      `the plan card; prose describing them is noise.\n\n` +
      `Before anything that leaves the machine or cannot be undone — sending an ` +
      `email, deleting something, changing a setting — state exactly what you ` +
      `are about to do and get agreement first. Read-only checks need no ` +
      `permission; irreversible ones always do.`,
    // run_applescript is deliberately absent. It stays in the registry as the
    // path the approval endpoint executes, but no specialist is given it: the
    // model proposes a script and a person runs it, so "the model composed
    // some AppleScript" and "AppleScript ran" are separated by a decision.
    tools: ["mac_recipe", "open_app", "propose_plan", "take_screenshot", "read_image", "read_skill"],
  },
  {
    name: "generalist",
    // "writing" used to be in this list, and it was bait: "write a note"
    // pattern-matched here instead of the operator, so the specialist with no
    // Notes tools got the request and narrated the note it could not create.
    // Composing text in the chat still lands here anyway -- it is the default.
    // "automations" is named here because the router only reads DESCRIPTIONS:
    // without the word, "create a hello world automation" pattern-matched the
    // coder's "writing code and files" and became an offer to write a Python
    // script -- a reasonable reading of the sentence and the wrong reading of
    // the product, where an automation is a saved flow built in its own panel.
    description:
      "Conversation, reasoning, explanation, the user's saved automations, or anything that doesn't fit the others.",
    systemPrompt:
      `You are a thoughtful assistant. Answer directly from what you know.\n\n` +
      `Use recall if the user refers to something from a past conversation. ` +
      `run_pipeline runs one of the user's saved automations when they ask for ` +
      `it by name. You cannot CREATE one: if they ask you to build or set up an ` +
      `automation, say it is built in the Automations panel — the workflow ` +
      `button in the top bar — where they describe it and get a draft to ` +
      `approve. Otherwise just answer — not everything needs a tool.`,
    // read_image belongs here as much as it belongs to coder and operator:
    // "what does this show?" is ordinary conversation, and it is the generalist
    // that gets routed it. Without the tool it had no way to look, so it said
    // it could not see images -- which was true of that specialist and false of
    // the agent.
    // run_pipeline is selection from a vouched closed list, never authoring:
    // the sixth and final slot, spent on letting "run my news pipeline" work.
    tools: ["recall", "current_time", "weather", "read_image", "read_skill", "run_pipeline"],
  },
];

export const DEFAULT_SPECIALIST = "generalist";

const routeSchema = z.object({
  specialist: z.enum([
    "researcher", "coder", "librarian", "mail", "operator", "generalist",
  ]),
});

/**
 * Picks a specialist for the request.
 *
 * Same technique as memory extraction: constrain the output to a closed set so
 * this is classification rather than generation. Anything unparseable falls
 * back to the generalist, which is the safe default because it has almost no
 * tools and cannot do damage.
 */
export async function route(
  userInput: string,
  previous: string | null = null,
): Promise<string> {
  // A known specialist from earlier in the conversation, or nothing. Validated
  // against the list because it comes from a database column that outlives
  // renames of the specialists themselves.
  const sticky = SPECIALISTS.some((s) => s.name === previous) ? previous! : null;

  // Very short inputs carry almost no routing signal of their own -- but they
  // are usually not greetings, they are follow-ups: "try again", "yes", "go
  // ahead". Resetting those to the generalist is how "try again" after a
  // failed Notes request landed on the one specialist with no Notes tools,
  // which then invented image paths to read. A short message continues the
  // conversation it is in; only a conversation with no history yet defaults.
  //
  // But only *one-word* inputs skip the router now. "open notes" is ten
  // characters and it is not a follow-up, it is a command -- routed by length
  // alone it stuck to whatever the conversation was already about and a chat
  // that had been about TCP answered it with prose about files. One word is a
  // greeting or an acknowledgement; several words is a small request, and
  // small requests get routed like any other, with the conversation's
  // specialist passed along as context for the genuine follow-ups.
  if (userInput.trim().length < 12 && !/\s/.test(userInput.trim())) {
    return sticky ?? DEFAULT_SPECIALIST;
  }

  const menu = SPECIALISTS.map((s) => `- ${s.name}: ${s.description}`).join("\n");

  // A prior, not an override: an open project of type "code" makes the
  // ambiguous "fix this" mean the coder, while "did Sam reply" still names
  // mail plainly enough to route away. This is what replaces the code-mode
  // other tools make the user enter -- the narrowing stays per turn, the
  // domain bias comes from what the user said this project is.
  const projectType = activeProject()?.type;
  const bias =
    projectType === "code"
      ? `The user is working in a code project, so when a request is ambiguous, prefer the coder.\n\n`
      : projectType === "planning"
        ? `The user is working in a planning project, so when a request is ambiguous, prefer the generalist.\n\n`
        : "";

  const messages: Message[] = [
    {
      role: "system",
      content:
        `Route the user's request to exactly one specialist.\n\n${menu}\n\n` +
        bias +
        (sticky
          ? `The conversation so far was handled by ${sticky}. Keep follow-ups ` +
            `("try again", "yes do it", "what about now") with ${sticky}; pick ` +
            `someone else only when the request clearly starts something new.\n\n`
          : "") +
        `Reply with ONLY this JSON, nothing else:\n` +
        `{"specialist": "name"}\n\n` +
        // One example per specialist. The model routes by pattern-matching
        // these far more than the descriptions, so a specialist with no
        // example effectively does not exist for anything its description's
        // exact words don't cover -- the operator was unreachable for "write
        // a note for groceries" until it got one.
        `Examples:\n` +
        `"what's new with the Vision Pro" -> {"specialist": "researcher"}\n` +
        `"why is my test failing" -> {"specialist": "coder"}\n` +
        // Documents are files, and write_file lives on the coder -- "build
        // me a resume" routed to the researcher, which can only answer in
        // prose, so nothing landed on disk and the canvas had nothing to
        // open. A note-in-an-app stays with the operator (the example
        // below); a document that should exist as a file is the coder's.
        `"build me a resume" -> {"specialist": "coder"}\n` +
        // The handoff flow: composing a prompt-file for a frontier model is
        // document work, and the ask-bigger-model skill rides the turn.
        `"ask a bigger model to write this" -> {"specialist": "coder"}\n` +
        `"write a document about our launch plan" -> {"specialist": "coder"}\n` +
        `"what did I say I was working on" -> {"specialist": "librarian"}\n` +
        // Saved documents live in the library, which the librarian searches;
        // "my files" without the library framing stays with the coder, whose
        // search_code covers the working workspace.
        `"find my notes about the tax audit" -> {"specialist": "librarian"}\n` +
        // "Where is <file> on my computer" is a name search, which is the
        // librarian's find_file -- not the coder, whose search is scoped to
        // the workspace and reads as "can't do that" for anything outside it.
        `"where is my tax return pdf on this computer" -> {"specialist": "librarian"}\n` +
        `"did Sam reply about the invoice" -> {"specialist": "mail"}\n` +
        `"write a note with my grocery list" -> {"specialist": "operator"}\n` +
        `"add lunch to my calendar for noon" -> {"specialist": "operator"}\n` +
        // Alarms, timers and reminders are Mac-app work, but nothing in the
        // operator's description says so -- "can you setup my alarm?" routed
        // to the generalist, which then denied a capability Enio has.
        `"set an alarm for 7 tomorrow morning" -> {"specialist": "operator"}\n` +
        // "pipeline" reads as CI: "run the quarterly-taxes pipeline" routed
        // to the coder, who has no run_pipeline tool and denied it exists.
        `"run my news-brief automation" -> {"specialist": "generalist"}\n` +
        // Authoring an automation is deliberately not a model act (composing
        // happens in the panel, where the user approves a draft). Routed to
        // the coder it read as "write me a script" and produced two empty
        // searches and six paragraphs of narration; the generalist is the
        // one whose prompt knows where automations come from.
        `"create an automation that emails me a summary" -> {"specialist": "generalist"}\n` +
        `"explain monads to me" -> {"specialist": "generalist"}`,
    },
    { role: "user", content: userInput.slice(0, 500) },
  ];

  try {
    // Greedy, not sampled. This is a classification with one right answer,
    // and at the config temperature the same request measurably routed
    // differently run to run.
    const result = await complete(messages, [], {}, undefined, { temperature: 0 });
    const match = /\{[\s\S]*\}/.exec(result.content);
    if (!match) return fuzzyRoute(result.content, sticky);
    const parsed = routeSchema.safeParse(JSON.parse(match[0]));
    return parsed.success ? parsed.data.specialist : fuzzyRoute(result.content, sticky);
  } catch {
    // A router that errored knows nothing; the conversation's history knows
    // something. Prefer it.
    return sticky ?? DEFAULT_SPECIALIST;
  }
}

/** The model often names the right specialist while failing to produce JSON.
 *  Salvaging that is worth more than a strict parse. */
function fuzzyRoute(text: string, sticky: string | null = null): string {
  const lower = text.toLowerCase();
  for (const s of SPECIALISTS) {
    if (lower.includes(s.name)) return s.name;
  }
  return sticky ?? DEFAULT_SPECIALIST;
}

export function getSpecialist(name: string): Specialist {
  return (
    SPECIALISTS.find((s) => s.name === name) ??
    SPECIALISTS.find((s) => s.name === DEFAULT_SPECIALIST)!
  );
}

/** Narrow a registry to what one specialist is allowed to see. */
export function toolsFor(specialist: Specialist, registry: Registry): ToolDef[] {
  const allowedServers = new Set(specialist.mcpServers ?? []);
  return registry.all.filter((tool) => {
    if (tool.origin === "mcp") {
      return tool.server ? allowedServers.has(tool.server) : false;
    }
    return specialist.tools.includes(tool.name);
  });
}
