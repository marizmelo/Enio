import { z } from "zod";
import { complete } from "./model.js";
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
    description:
      "Questions about the outside world, current events, documentation, or anything needing a web lookup.",
    systemPrompt:
      `You research things on the web and report what you find.\n\n` +
      `Search first, then fetch the most promising result to read it properly — ` +
      `snippets are often misleading. If a fetched page comes back nearly empty, ` +
      `it renders with JavaScript; retry it with web_fetch_rendered.\n\n` +
      `Cite the URL for anything you assert. If the sources disagree, say so ` +
      `rather than picking one silently. If you could not find something, say ` +
      `that plainly — a confident wrong answer is worse than an admission.`,
    // weather lives here as well as on the generalist because this is where
    // the router actually sends "what is it like outside" -- it reads as a
    // question about the world, which is exactly this specialist's description.
    // Overlap is the lesser evil: a tool on two specialists costs a slot, a
    // tool on the wrong one costs the answer.
    tools: ["web_search", "web_fetch", "web_fetch_rendered", "recall", "weather", "read_skill"],
  },
  {
    name: "coder",
    description:
      "Reading, writing, running, debugging or explaining code and files in the workspace.",
    systemPrompt:
      `You work with code in the user's workspace.\n\n` +
      `Look before you edit: list the directory and read the file rather than ` +
      `assuming its contents. After a change, run the relevant test or build ` +
      `command to check it. Report what you actually observed, including ` +
      `failures — do not describe an intended outcome as if it happened.\n\n` +
      `Everything is scoped to the workspace directory. Paths outside it are ` +
      `refused, which is expected, not a bug to work around.`,
    tools: ["read_file", "write_file", "list_dir", "run_command", "read_image", "read_skill"],
    mcpServers: ["filesystem", "git", "github"],
  },
  {
    name: "librarian",
    description:
      "Anything about the user themselves, their preferences, or earlier conversations.",
    systemPrompt:
      `You manage what is known about the user.\n\n` +
      `Call recall before answering questions about them — do not guess from ` +
      `the conversation alone. When they state something durable about ` +
      `themselves, store it with remember, one self-contained fact per call. ` +
      `When they state how they want you to behave, use set_preference instead: ` +
      `preferences shape every future conversation, facts only inform them.\n\n` +
      `If memory holds nothing relevant, say so rather than inventing continuity.`,
    tools: ["recall", "remember", "set_preference", "read_skill"],
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
    description:
      "Doing something on the machine: checking the screen, controlling Calendar, Notes, Finder, Music, or running a Shortcut.",
    systemPrompt:
      `You operate the user's Mac.\n\n` +
      `For reading Mail, Calendar, Notes, Reminders or Finder, use mac_recipe ` +
      `and pick the recipe by name. Do not write AppleScript for these — the ` +
      `recipes are already correct, and a script you compose will not be. ` +
      `take_screenshot shows you what is on screen.\n\n` +
      `run_applescript is for things no recipe covers. Writing one is a last ` +
      `resort: say what the script will do and let the user confirm before you ` +
      `run it, rather than trying variations until something works.\n\n` +
      `Before anything that leaves the machine or cannot be undone — sending an ` +
      `email, deleting something, changing a setting — state exactly what you ` +
      `are about to do and get agreement first. Read-only checks need no ` +
      `permission; irreversible ones always do.`,
    tools: ["mac_recipe", "run_applescript", "take_screenshot", "read_image", "read_skill"],
  },
  {
    name: "generalist",
    description:
      "Conversation, reasoning, explanation, writing, or anything that doesn't fit the others.",
    systemPrompt:
      `You are a thoughtful assistant. Answer directly from what you know.\n\n` +
      `Use recall if the user refers to something from a past conversation. ` +
      `Otherwise just answer — not everything needs a tool.`,
    // read_image belongs here as much as it belongs to coder and operator:
    // "what does this show?" is ordinary conversation, and it is the generalist
    // that gets routed it. Without the tool it had no way to look, so it said
    // it could not see images -- which was true of that specialist and false of
    // the agent.
    tools: ["recall", "current_time", "weather", "read_image", "read_skill"],
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
export async function route(userInput: string): Promise<string> {
  // Very short inputs carry almost no routing signal, and a greeting doesn't
  // deserve a second model call.
  if (userInput.trim().length < 12) return DEFAULT_SPECIALIST;

  const menu = SPECIALISTS.map((s) => `- ${s.name}: ${s.description}`).join("\n");

  const messages: Message[] = [
    {
      role: "system",
      content:
        `Route the user's request to exactly one specialist.\n\n${menu}\n\n` +
        `Reply with ONLY this JSON, nothing else:\n` +
        `{"specialist": "name"}\n\n` +
        `Examples:\n` +
        `"what's new with the Vision Pro" -> {"specialist": "researcher"}\n` +
        `"why is my test failing" -> {"specialist": "coder"}\n` +
        `"what did I say I was working on" -> {"specialist": "librarian"}\n` +
        `"explain monads to me" -> {"specialist": "generalist"}`,
    },
    { role: "user", content: userInput.slice(0, 500) },
  ];

  try {
    const result = await complete(messages, []);
    const match = /\{[\s\S]*\}/.exec(result.content);
    if (!match) return fuzzyRoute(result.content);
    const parsed = routeSchema.safeParse(JSON.parse(match[0]));
    return parsed.success ? parsed.data.specialist : fuzzyRoute(result.content);
  } catch {
    return DEFAULT_SPECIALIST;
  }
}

/** The model often names the right specialist while failing to produce JSON.
 *  Salvaging that is worth more than a strict parse. */
function fuzzyRoute(text: string): string {
  const lower = text.toLowerCase();
  for (const s of SPECIALISTS) {
    if (lower.includes(s.name)) return s.name;
  }
  return DEFAULT_SPECIALIST;
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
