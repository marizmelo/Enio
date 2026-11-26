import { distinctiveTerms } from "./memory/terms.js";
import { complete } from "./model.js";
import type { Message } from "./types.js";

/**
 * The words a seeded web search runs with, when the question leans on the
 * conversation it was asked in.
 *
 * The researcher's search runs before the model's first call, with the
 * user's own words as the query (see the seed in agent.ts). That is right
 * for a first question and wrong for a second one. Watched: "weren't there
 * games for the Brazilian Cup yesterday?" was answered, and then "What
 * happened to Flamengo?" searched for exactly those four words — a
 * Wikipedia page, a Florida restaurant, and a Copa Libertadores dispute.
 * The thread was in the prompt the whole time. It made no difference,
 * because by the model's first call the pages in front of it were about
 * something else, and the instruction it follows best is "answer from these
 * results". The user had to ask a third time with the cup spelled out.
 *
 * So the query is completed from the thread, and only from the thread. The
 * model is asked for a transformation, not a composition: here are the
 * earlier questions and the last answer, here is the new one, hand back the
 * new one with what it leaves out. Then the harness checks the result the
 * way it checks a plan's figures — every word the model added must already
 * be in the conversation, and every word the user typed that names
 * something must still be there. A rewrite that fails either is discarded
 * and the user's own words are searched, which is the old behaviour, so
 * this can make a search better and cannot make one about something the
 * user never mentioned.
 *
 * It costs one short model call, and only on a research question that has
 * a thread behind it; a first question never pays. The seed's comment says
 * composing a better query would be a model call and the seed exists to
 * remove latency — it removed 82 seconds of confident fiction, and half a
 * second on top of a search and a 30-second answer is not that trade.
 */

const QUERY_CHARS = 200;
const QUESTION_CHARS = 200;
const REPLY_CHARS = 600;
const QUESTIONS_SHOWN = 3;

/**
 * Words that stand for something said earlier. A rewrite is allowed to
 * drop these, because replacing them is the point: "how much does it cost"
 * becomes "how much does the Acer Aspire 5 cost". Everything else the user
 * typed is the subject and has to survive.
 */
const STAND_INS = new Set(
  "them they their theirs it its he she him his her hers one ones same also else again more that this those these there then".split(" "),
);

export interface SeedQuery {
  /** What to search for. */
  query: string;
  /** "words" is the user's question as typed; "thread" is it completed from the conversation. */
  via: "words" | "thread";
  /** The terms the thread supplied, for the trace. Empty when via is "words". */
  added: string[];
}

/** What the conversation before this question holds: the last few things
 *  the user asked, and the answer the new question most likely follows. */
export function threadBefore(history: Message[]): { questions: string[]; reply: string; text: string } {
  // The last message is the question being asked now.
  const prior = history.slice(0, -1).filter((m) => typeof m.content === "string" && m.content);
  const questions = prior
    .filter((m) => m.role === "user")
    .map((m) => String(m.content).trim())
    // A parenthesised user message is the harness speaking, not the user.
    .filter((q) => q && !q.startsWith("("));
  const replies = prior.filter((m) => m.role === "assistant").map((m) => String(m.content).trim());
  return {
    questions: questions.slice(-QUESTIONS_SHOWN).map((q) => q.slice(0, QUESTION_CHARS)),
    reply: (replies.at(-1) ?? "").slice(0, REPLY_CHARS),
    text: [...questions, ...replies].join("\n"),
  };
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/**
 * Whether a rewritten query may replace the user's words.
 *
 * Two refusals, both one-directional. The model may not drop a word that
 * names something ("who won the F1 race in Brazil" must not come back
 * about the cup the thread was on), and it may not bring a word the
 * conversation never held. Returns the terms the thread supplied, or null
 * when the rewrite is refused or adds nothing.
 */
export function acceptRewrite(question: string, rewrite: string, thread: string): string[] | null {
  const query = rewrite.trim();
  if (!query || query.length > QUERY_CHARS || /\n/.test(query)) return null;
  const inQuery = words(query);
  const typed = distinctiveTerms(question);
  for (const term of typed) {
    if (!STAND_INS.has(term) && !inQuery.has(term)) return null;
  }
  const inQuestion = words(question);
  const added = distinctiveTerms(query).filter((t) => !inQuestion.has(t));
  if (added.length === 0) return null;
  const inThread = words(thread);
  if (!added.every((t) => inThread.has(t))) return null;
  return added;
}

const SYSTEM =
  "You complete a follow-up question so it can be used as a web search query.\n\n" +
  "You are given the earlier questions of a conversation, the last answer, and a new question. " +
  "Decide whether the new question continues the same subject.\n" +
  "- If it continues and leaves out what it is about, add the missing words from the conversation. " +
  "Keep the new question's own words.\n" +
  "- If it starts a new subject, or already says what it is about, return it unchanged.\n" +
  "Use only words that appear in the conversation. Never answer the question.\n\n" +
  "Reply with ONLY this JSON, nothing else:\n" +
  '{"continues": true, "query": "..."}\n\n' +
  "Examples:\n" +
  "Earlier questions:\n- who won the champions league final last season\n" +
  "Last answer: Paris Saint-Germain won the 2025 final, beating Inter 5-0 in Munich.\n" +
  "New question: who scored?\n" +
  '{"continues": true, "query": "who scored in the 2025 champions league final Paris Saint-Germain Inter"}\n\n' +
  "Earlier questions:\n- what's the best budget laptop right now\n" +
  "Last answer: The Acer Aspire 5 is the usual pick under $600.\n" +
  "New question: how much does it cost in europe?\n" +
  '{"continues": true, "query": "how much does the Acer Aspire 5 cost in europe"}\n\n' +
  "Earlier questions:\n- were there any formula 1 races last weekend\n" +
  "Last answer: No. The next race is the Las Vegas Grand Prix.\n" +
  "New question: what happened to Ferrari?\n" +
  '{"continues": true, "query": "what happened to Ferrari formula 1 last weekend"}\n\n' +
  "Earlier questions:\n- is it going to rain in lisbon tomorrow\n" +
  "Last answer: Yes, showers are expected in Lisbon tomorrow afternoon.\n" +
  "New question: what is the capital of australia?\n" +
  '{"continues": false, "query": "what is the capital of australia?"}\n\n' +
  "Earlier questions:\n- who is the ceo of nvidia\n" +
  "Last answer: Jensen Huang has led Nvidia since it was founded.\n" +
  "New question: latest news on the eu ai act\n" +
  '{"continues": false, "query": "latest news on the eu ai act"}';

/**
 * The query for a seeded search. Never throws and never returns nothing:
 * whatever goes wrong, the user's own words are searched, as they always
 * were.
 */
export async function seedQuery(userInput: string, history: Message[]): Promise<SeedQuery> {
  const typed: SeedQuery = { query: userInput.trim().slice(0, QUERY_CHARS), via: "words", added: [] };
  const thread = threadBefore(history);
  if (thread.questions.length === 0) return typed;
  try {
    const result = await complete(
      [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content:
            `Earlier questions:\n${thread.questions.map((q) => `- ${q}`).join("\n")}\n` +
            (thread.reply ? `Last answer: ${thread.reply.replace(/\s+/g, " ")}\n` : "") +
            `New question: ${typed.query}`,
        },
      ],
      [],
      {},
      undefined,
      // A closed decision and a short string: greedy, and no room to wander.
      { temperature: 0, maxTokens: 120, enableThinking: false },
    );
    const match = /\{[\s\S]*\}/.exec(result.content);
    if (!match) return typed;
    const parsed = JSON.parse(match[0]) as { continues?: unknown; query?: unknown };
    if (parsed.continues !== true || typeof parsed.query !== "string") return typed;
    const added = acceptRewrite(typed.query, parsed.query, thread.text);
    if (!added) return typed;
    return { query: parsed.query.trim(), via: "thread", added };
  } catch {
    return typed;
  }
}
