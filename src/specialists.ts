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
    tools: ["web_search", "web_fetch", "web_fetch_rendered", "recall"],
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
    tools: ["read_file", "write_file", "list_dir", "run_command"],
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
    tools: ["recall", "remember", "set_preference"],
  },
  {
    name: "generalist",
    description:
      "Conversation, reasoning, explanation, writing, or anything that doesn't fit the others.",
    systemPrompt:
      `You are a thoughtful assistant. Answer directly from what you know.\n\n` +
      `Use recall if the user refers to something from a past conversation. ` +
      `Otherwise just answer — not everything needs a tool.`,
    tools: ["recall"],
  },
];

export const DEFAULT_SPECIALIST = "generalist";

const routeSchema = z.object({
  specialist: z.enum(["researcher", "coder", "librarian", "generalist"]),
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
