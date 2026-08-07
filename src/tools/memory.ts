import type { ToolDef } from "../types.js";
import { rememberFact, searchFacts, searchGraph } from "../memory/store.js";
import { addPreference } from "../memory/learning.js";

/**
 * Memory tools the model calls explicitly.
 *
 * These complement the automatic batch extraction rather than replacing it.
 * Automatic extraction catches what was implied; `remember` catches what the
 * user directly asked to be kept, which is exactly the class of fact that
 * matters most and that a weak extractor is most likely to miss.
 */

let currentSessionId = "";
export const setMemorySession = (id: string) => {
  currentSessionId = id;
};

export const memoryTools: ToolDef[] = [
  {
    name: "remember",
    description:
      "Store a durable fact about the user for future conversations. Use when the user shares a preference, a detail about their work, or explicitly asks you to remember something. Write one self-contained fact per call.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          description:
            "A single self-contained fact, written so it makes sense with no other context. E.g. 'Mariz prefers TypeScript over Python for agent code'.",
        },
        important: {
          type: "boolean",
          description:
            "True for core identity or standing preferences that should be recalled in every conversation.",
        },
      },
      required: ["fact"],
    },
    async run(args) {
      const fact = String(args.fact ?? "").trim();
      const result = await rememberFact(fact, {
        pinned: args.important === true,
        sessionId: currentSessionId,
      });
      if (!result.stored) return `Not stored (${result.reason}).`;
      return `Remembered: ${fact}`;
    },
  },
  {
    name: "set_preference",
    description:
      "Record how the user wants you to behave in all future conversations — tone, format, length, things to avoid. Use this when they tell you HOW to respond, as opposed to a fact about themselves. Write it as a directive.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        preference: {
          type: "string",
          description:
            "A single behavioural directive, e.g. 'Answer concisely and skip preamble' or 'Never use bullet points'.",
        },
      },
      required: ["preference"],
    },
    async run(args) {
      const text = String(args.preference ?? "").trim();
      const result = addPreference(text);
      return result.added ? `Preference set: ${text}` : `Not set (${result.reason}).`;
    },
  },
  {
    name: "recall",
    description:
      "Search your memory for what you know about a topic, including past conversations. Use this when the user refers to something from before, or when personal context would change your answer.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up." },
      },
      required: ["query"],
    },
    async run(args) {
      const query = String(args.query ?? "").trim();
      if (!query) return "Error: empty query.";

      const [facts, graph] = await Promise.all([
        searchFacts(query, 8),
        searchGraph(query, 10),
      ]);

      const parts: string[] = [];
      if (facts.length > 0) {
        parts.push("Facts:\n" + facts.map((f) => `- ${f.text}`).join("\n"));
      }
      if (graph.length > 0) {
        parts.push(
          "Relationships:\n" +
            graph
              .map(
                (g) =>
                  `- ${g.subject} ${g.relation.toLowerCase().replace(/_/g, " ")} ${g.object}`,
              )
              .join("\n"),
        );
      }
      return parts.length > 0
        ? parts.join("\n\n")
        : `Nothing found for "${query}". This may simply not have come up before.`;
    },
  },
];
