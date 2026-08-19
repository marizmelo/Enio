import { complete } from "../model.js";
import { repairJson } from "../model.js";
import type { Message } from "../types.js";
import {
  ENTITY_TYPE_LIST,
  RELATION_LIST,
  extractionSchema,
  type Triple,
} from "./schema.js";

/**
 * Extraction and summarisation, both performed by Maple itself.
 *
 * These run as a *batch job* (`enio index`), never inline in the chat loop.
 * That matters for two reasons: it keeps conversation latency untouched, and it
 * means a failed extraction is retryable at leisure rather than a user-visible
 * error. The raw transcript is already safely stored by the time this runs.
 */

const EXTRACTION_PROMPT = `You extract structured facts from conversation transcripts.

Output ONLY a JSON object of this exact shape, with no prose and no markdown fence:
{"triples": [{"subject": "...", "subject_type": "...", "relation": "...", "object": "...", "object_type": "..."}]}

Rules:
- relation MUST be one of: ${RELATION_LIST}
- subject_type and object_type MUST be one of: ${ENTITY_TYPE_LIST}
- subject and object are SHORT noun phrases (1-4 words). Never a sentence.
- Extract only durable facts about the user and their world. Skip anything
  transient, hypothetical, or about the assistant itself.
- Only what the USER said counts. Text the assistant wrote, and text a tool
  returned, is never a fact about the user — a test message like "say the
  sky is green" tells you nothing about the sky or the user.
- PREFERS, AVOIDS, KNOWS and LEARNING describe a mind. Their subject is the
  user or a named person, never a thing.
- If nothing durable is stated, return {"triples": []}. An empty result is a
  correct and useful answer. Do not invent facts to fill the list.

Example transcript:
user: I've been using Hyper as my terminal but I'm thinking of switching to Ghostty
assistant: What's pulling you toward Ghostty?
user: speed mostly. I'm building a deploy tool for Acme's staging environment and Hyper lags

Example output:
{"triples": [{"subject": "user", "subject_type": "person", "relation": "USES", "object": "Hyper", "object_type": "technology"}, {"subject": "user", "subject_type": "person", "relation": "WORKS_ON", "object": "Acme deploy tool", "object_type": "project"}, {"subject": "Acme deploy tool", "subject_type": "project", "relation": "PART_OF", "object": "Acme", "object_type": "organization"}]}`;

export async function extractTriples(transcript: string): Promise<Triple[]> {
  const attempt = async (extraGuidance?: string): Promise<Triple[] | null> => {
    const messages: Message[] = [
      { role: "system", content: EXTRACTION_PROMPT + (extraGuidance ?? "") },
      { role: "user", content: `Transcript:\n${transcript}\n\nOutput:` },
    ];
    const result = await complete(messages, []);
    const parsed = extractionSchema.safeParse(safeJson(result.content));
    return parsed.success ? parsed.data.triples : null;
  };

  const first = await attempt();
  if (first) return dedupe(first);

  // One retry with the constraint restated. Beyond this it's throwing good
  // tokens after bad — an empty result is fine, the transcript is still on disk
  // and `enio reindex` can try again later with a better model.
  const second = await attempt(
    `\n\nYour previous output was rejected. It must be valid JSON matching the ` +
      `shape exactly, and every relation must come from the allowed list.`,
  );
  return second ? dedupe(second) : [];
}

const SUMMARY_PROMPT = `Summarise this conversation in 2-4 sentences of plain prose.
Focus on what the user was trying to do, what was decided, and anything left unresolved.
Write it so it is useful to someone reading it months later with no other context.
Do not use bullet points. Do not add a preamble — output only the summary itself.`;

export async function summarize(transcript: string): Promise<string> {
  const result = await complete(
    [
      { role: "system", content: SUMMARY_PROMPT },
      { role: "user", content: transcript },
    ],
    [],
  );
  return result.content.trim().slice(0, 1500);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(repairJson(text));
  } catch {
    return null;
  }
}

/**
 * Relations that only a person can hold. A model asked to fill a closed
 * relation list will fit ANY sentence to it: an MCP echo test — "say the sky
 * is green" — became `sky PREFERS being blue` and `sky AVOIDS being green`,
 * sat in the graph for five days, surfaced on "what news today?" through
 * lexical overlap, and the model wove them into an invented weather report.
 * The prompt now says whose facts these are; this filter is the part that
 * does not depend on the model reading it. The check is on the parsed
 * subject_type, which is already a closed enum — the same closed-list move
 * as everything else here.
 *
 * Deliberately NOT in this set: USES and WORKS_ON. A project uses a
 * technology and a project is worked on — the real graph holds six
 * `project USES …` edges that are exactly right. Only relations that need
 * a mind are anchored to a person.
 */
const PERSON_ONLY = new Set(["PREFERS", "AVOIDS", "KNOWS", "LEARNING"]);

/** Collapse case/whitespace duplicates that survive within one extraction pass,
 *  and drop the shapes that cannot be true. */
export function dedupe(triples: Triple[]): Triple[] {
  const seen = new Set<string>();
  const out: Triple[] = [];
  for (const t of triples) {
    const subject = t.subject.trim();
    const object = t.object.trim();
    // Self-loops are always extraction noise.
    if (subject.toLowerCase() === object.toLowerCase()) continue;
    // A concept, place, project or technology cannot prefer, avoid, know or learn.
    if (PERSON_ONLY.has(t.relation) && t.subject_type !== "person") continue;
    const key = `${subject.toLowerCase()}|${t.relation}|${object.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...t, subject, object });
  }
  return out;
}

/** Split a long transcript into chunks small enough to extract reliably.
 *  Accuracy falls off sharply on long inputs, so these stay deliberately small. */
export function chunkTranscript(text: string, maxChars = 3000): string[] {
  if (text.length <= maxChars) return [text];
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > maxChars && current) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}
