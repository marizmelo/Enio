import { abstains } from "./adapters.js";
import { callStatus } from "./tool-detail.js";
import { config } from "./config.js";
import { embedBatch, embeddingsDegraded } from "./memory/embed.js";
import { nearestLabel, embedMissing, type Embedder, type Nearest } from "./nearest.js";

/**
 * The reply's mood: a label the harness picks from four, never a feeling
 * the model reports.
 *
 * The desktop's face needs one word per reply -- pleased, sorry, unsure,
 * or nothing in particular -- and asking the model for it would be the
 * self-judgement everything here avoids (DECISIONS.md rejects a model that
 * describes its own personality for the same reason), at a tag's worth of
 * tokens on every turn that a 4B garbles often enough to matter. So the
 * label comes from what ran and what was said: a failed tool call the
 * reply owns up to is `sorry`; a reply the abstention grammar recognises is
 * `unsure`; otherwise the nearest authored example decides, when its margin
 * over the runner-up clears a measured threshold, and `neutral` is the
 * floor. The same nearest-example move as the router's fast tier, over the
 * same embeddings, with its own bench (scripts/mood-bench.mjs).
 *
 * Nothing here may cost a turn: every entry point swallows its own errors
 * and answers `neutral`.
 */

export const MOODS = ["neutral", "happy", "sorry", "unsure"] as const;
export type Mood = (typeof MOODS)[number];

/**
 * Authored, first-person, the length of a spoken sentence. Neutral has
 * examples too: without them every plain sentence would be forced onto
 * one of the other three with some margin, and the floor would never win.
 * Held-out replies live in scripts/mood-bench-data.mjs; a test keeps the
 * two sets disjoint.
 */
export const MOOD_EXAMPLES: ReadonlyArray<{ text: string; mood: Mood }> = [
  // happy: something worked, or good news
  { text: "Done — the file is saved and the tests pass.", mood: "happy" },
  { text: "All set: the meeting is on your calendar for Tuesday at ten.", mood: "happy" },
  { text: "Good news: the build is green again.", mood: "happy" },
  { text: "That worked. The script ran cleanly and wrote the report.", mood: "happy" },
  { text: "Sent. Your reply went out a moment ago.", mood: "happy" },
  { text: "Found it — the note you wanted is in the project folder.", mood: "happy" },
  { text: "Nice, that is exactly the right fix.", mood: "happy" },
  { text: "Yes, that approach works, and it is the simpler one.", mood: "happy" },
  { text: "Happy to help with that; here is the summary you asked for.", mood: "happy" },
  { text: "The download finished and the model is ready to use.", mood: "happy" },
  // sorry: something failed, or the earlier answer was wrong
  { text: "I couldn't reach that page; the request timed out.", mood: "sorry" },
  { text: "Sorry — the command failed with an error, so nothing was changed.", mood: "sorry" },
  { text: "That didn't work: the file could not be written because the folder is read-only.", mood: "sorry" },
  { text: "I wasn't able to send the email; the account is not connected.", mood: "sorry" },
  { text: "The search returned an error, so I have no results to show you.", mood: "sorry" },
  { text: "Apologies, I misread the question earlier; here is the corrected answer.", mood: "sorry" },
  { text: "I ran out of room before finishing that; try a shorter request.", mood: "sorry" },
  { text: "Unfortunately the server refused the request, so the download did not start.", mood: "sorry" },
  { text: "I could not complete that step; the test suite failed to start.", mood: "sorry" },
  { text: "Sorry about that — the previous reply was wrong.", mood: "sorry" },
  // unsure: nothing to answer from
  { text: "I don't have anything on that in memory.", mood: "unsure" },
  { text: "I'm not sure; nothing I can see answers that question.", mood: "unsure" },
  { text: "There is no record of that conversation in my notes.", mood: "unsure" },
  { text: "I can't find a file by that name anywhere in the workspace.", mood: "unsure" },
  { text: "I don't know when that was decided; it is not mentioned in anything I have.", mood: "unsure" },
  { text: "That isn't something I have information about.", mood: "unsure" },
  { text: "I couldn't find any mention of her in the documents.", mood: "unsure" },
  { text: "Nothing in the project covers that, so I would be guessing.", mood: "unsure" },
  { text: "I'm not certain which account you mean; there are two connected.", mood: "unsure" },
  { text: "There is no function with that name in this codebase.", mood: "unsure" },
  // neutral: information, instructions, narration
  { text: "The function takes two arguments and returns the sum.", mood: "neutral" },
  { text: "Your next meeting is at three o'clock with the design team.", mood: "neutral" },
  { text: "The weather in Lisbon is twenty-two degrees and clear.", mood: "neutral" },
  { text: "Here are the three files that changed since the last commit.", mood: "neutral" },
  { text: "Compound interest is interest calculated on both the principal and the accumulated interest.", mood: "neutral" },
  { text: "The server is listening on port 8787.", mood: "neutral" },
  { text: "To restart the app, quit it from the tray menu and open it again.", mood: "neutral" },
  { text: "The note has four sections: context, options, decision, and next steps.", mood: "neutral" },
  { text: "That command lists the processes using the most memory.", mood: "neutral" },
  { text: "The project uses TypeScript on Node 22 with SQLite for memory.", mood: "neutral" },
  { text: "I have opened the Connections panel.", mood: "neutral" },
  { text: "Reading the file now.", mood: "neutral" },
];

/** A reply that owns a failure, in the words replies use for it. */
export const ACKNOWLEDGES_FAILURE =
  /\b(couldn'?t|could not|failed|unable|error|timed out|didn'?t work|wasn'?t able|not able to)\b/i;

/**
 * The first complete sentence of streamed text, or null while there is
 * none. The same rule the renderer speaks by (takeSentences in speech.js):
 * a terminator followed by whitespace, so "127.0.0.1" and "e.g." do not
 * end a sentence -- voice and face must agree on where sentence one ends.
 */
export function firstSentence(text: string): string | null {
  const m = /^[\s\S]*?[.!?](?=\s)/.exec(text);
  return m ? m[0].trim() : null;
}

export interface StepLike {
  kind: string;
  output?: string | null;
  error?: string | null;
}

/** The last tool call of the turn went wrong, by the tool's own account. */
export function lastToolFailed(steps: ReadonlyArray<StepLike>): boolean {
  let last: StepLike | undefined;
  for (const s of steps) if (s.kind === "tool") last = s;
  if (!last) return false;
  return Boolean(last.error) || callStatus(String(last.output ?? "")) === "failed";
}

/**
 * The rules, before any classifier: they read what ran, which no example
 * can. An acknowledged failure wins over an abstention because the
 * abstention grammar also matches "couldn't find" and "not found", which
 * describe a failed call as readily as a gap in memory.
 */
export function moodByRule(reply: string, steps: ReadonlyArray<StepLike>): Mood | null {
  if (lastToolFailed(steps) && ACKNOWLEDGES_FAILURE.test(reply)) return "sorry";
  if (abstains(reply, false)) return "unsure";
  return null;
}

const cache = new Map<string, Float32Array>();
let testEmbedder: Embedder | null = null;

/** Test seam: a deterministic embedder, bypassing the load gate below. */
export function setMoodEmbedder(fn: Embedder | null): void {
  testEmbedder = fn;
  cache.clear();
}

/**
 * The embedder a turn may use. The real one only once something has
 * already embedded successfully in this process: the model loads lazily,
 * and a turn must never be the thing that starts that load -- it costs
 * most of a second, and in the test suites that script every fetch the
 * download itself would be answered with a model reply. Boot warms it
 * (warmMood) and memory recall loads it; a turn only ever reuses it.
 */
function turnEmbedder(): Embedder | null {
  if (testEmbedder) return testEmbedder;
  return embeddingsDegraded() === false ? embedBatch : null;
}

export async function classifyMood(
  text: string,
  opts: { embedder?: Embedder } = {},
): Promise<(Nearest<Mood> & { ms: number }) | null> {
  const embedder = opts.embedder ?? turnEmbedder();
  if (!embedder) return null;
  const started = Date.now();
  await embedMissing(cache, MOOD_EXAMPLES.map((e) => e.text), embedder);
  const ready = MOOD_EXAMPLES.filter((e) => cache.has(e.text)).map((e) => ({
    text: e.text,
    label: e.mood,
    vector: cache.get(e.text)!,
  }));
  if (ready.length === 0) return null;
  const [query] = await embedder([text.slice(0, 500)]);
  if (!query) return null;
  const n = nearestLabel(query, ready);
  return n ? { ...n, ms: Date.now() - started } : null;
}

export interface MoodVerdict {
  mood: Mood;
  how: "rule" | "classifier" | "fallback";
  margin: number | null;
  runnerUp: Mood | null;
  ms: number;
}

/** Rules, then the classifier over the threshold, then neutral. Never throws. */
export async function moodFor(
  reply: string,
  steps: ReadonlyArray<StepLike>,
  opts: { embedder?: Embedder } = {},
): Promise<MoodVerdict> {
  const started = Date.now();
  try {
    const rule = moodByRule(reply, steps);
    if (rule) return { mood: rule, how: "rule", margin: null, runnerUp: null, ms: Date.now() - started };
    const n = await classifyMood(reply, opts);
    if (n && n.margin >= config.moodMargin) {
      return { mood: n.label, how: "classifier", margin: n.margin, runnerUp: n.runnerUp, ms: Date.now() - started };
    }
    return { mood: "neutral", how: "fallback", margin: n?.margin ?? null, runnerUp: n?.runnerUp ?? null, ms: Date.now() - started };
  } catch {
    return { mood: "neutral", how: "fallback", margin: null, runnerUp: null, ms: Date.now() - started };
  }
}

/** Embed the examples ahead of the first turn. Boot calls this; it is the
 *  one place allowed to start the model load (see turnEmbedder). */
export function warmMood(): void {
  void embedMissing(cache, MOOD_EXAMPLES.map((e) => e.text), embedBatch).catch(() => undefined);
}

export interface MoodStep {
  mood: Mood;
  how: MoodVerdict["how"];
  margin: number | null;
  ms: number;
}

/**
 * One turn's labelling, as the loop drives it.
 *
 * The label goes out once the first sentence exists -- speech starts
 * there, and a face that reacts after the voice has finished reacts late.
 * Text that precedes a tool call is narration ("Let me check"), so the
 * window re-arms after every tool round. A withdrawn reply forgets what
 * it sent, because the client resets the face on the restart and the
 * correction must get a frame even when its label repeats. At the end,
 * only the rules may change the classifier's mind: they need the whole
 * reply (an apology for a failed call, an abstention), and a reply with
 * no sentence terminator ("Done") was never labelled at all.
 */
export interface MoodTrack {
  streamed(delta: string): void;
  label(text: string): Promise<void>;
  rearm(): void;
  reset(): void;
  settle(reply: string): Promise<MoodStep | null>;
  readonly sent: Mood | null;
}

export function createMoodTrack(steps: ReadonlyArray<StepLike>, onMood: (mood: Mood) => void): MoodTrack {
  const state: { spoken: string; armed: boolean; sent: Mood | null; verdict: MoodVerdict | null; pending: Promise<void> } = {
    spoken: "",
    armed: true,
    sent: null,
    verdict: null,
    pending: Promise.resolve(),
  };
  const send = (v: MoodVerdict) => {
    state.verdict = v;
    if (v.mood !== state.sent) {
      state.sent = v.mood;
      try {
        onMood(v.mood);
      } catch {
        // A client that cannot take the frame does not get to end the turn.
      }
    }
  };
  const label = (text: string): Promise<void> => {
    state.armed = false;
    state.pending = moodFor(text, steps).then(send).catch(() => undefined);
    return state.pending;
  };
  return {
    streamed(delta) {
      if (!state.armed) return;
      state.spoken += delta;
      const first = firstSentence(state.spoken);
      if (first) void label(first);
    },
    label,
    rearm() {
      state.spoken = "";
      state.armed = true;
    },
    reset() {
      state.spoken = "";
      state.armed = true;
      state.sent = null;
      state.verdict = null;
    },
    async settle(reply) {
      try {
        await state.pending;
        if (!reply.trim()) return null;
        const rule = moodByRule(reply, steps);
        if (rule) send({ mood: rule, how: "rule", margin: null, runnerUp: null, ms: 0 });
        else if (state.sent === null) send(await moodFor(reply, steps));
        if (!state.sent) return null;
        return {
          mood: state.sent,
          how: state.verdict?.how ?? "fallback",
          margin: state.verdict?.margin ?? null,
          ms: state.verdict?.ms ?? 0,
        };
      } catch {
        return null;
      }
    },
    get sent() {
      return state.sent;
    },
  };
}
