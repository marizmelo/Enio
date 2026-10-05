import { cosine } from "./memory/db.js";
import { embedBatch } from "./memory/embed.js";

/**
 * Nearest-example classification over a closed list of labels.
 *
 * The router's fast tier and the reply-mood label make the same move: a
 * choice from a short list, decided by which authored example the input
 * sits closest to, with the gap to the runner-up as the confidence. The
 * maths lives here, a leaf with no knowledge of specialists or moods, so
 * both callers share one implementation and the benchmarks that calibrate
 * their thresholds measure the same thing.
 *
 * Each label is scored by its BEST example, not the average: a label with
 * many examples must not be diluted by its distant ones, and one with a
 * single sharp example must still be able to win.
 */

export interface Labelled<L extends string> {
  text: string;
  label: L;
  vector: Float32Array;
}

export interface Nearest<L extends string> {
  label: L;
  runnerUp: L | null;
  /** Best label's score minus the second best's: the confidence. */
  margin: number;
  scores: Record<string, number>;
}

/** Pure, so a benchmark or a test can drive it with vectors of its own. */
export function nearestLabel<L extends string>(
  query: Float32Array,
  exemplars: ReadonlyArray<Labelled<L>>,
): Nearest<L> | null {
  const scores: Record<string, number> = {};
  for (const e of exemplars) {
    const s = cosine(query, e.vector);
    if (!(e.label in scores) || s > scores[e.label]!) scores[e.label] = s;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  const [best, second] = ranked;
  return {
    label: best![0] as L,
    runnerUp: (second?.[0] as L | undefined) ?? null,
    margin: best![1] - (second?.[1] ?? 0),
    scores,
  };
}

export type Embedder = (texts: string[]) => Promise<(Float32Array | null)[]>;

/**
 * Embed whatever the cache lacks, in one batch. A text whose embedding
 * failed stays absent rather than being cached as a miss, so a later call
 * retries it -- the model loads lazily and the first attempt can lose.
 */
export async function embedMissing(
  cache: Map<string, Float32Array>,
  texts: ReadonlyArray<string>,
  embedder: Embedder = embedBatch,
): Promise<void> {
  const missing = [...new Set(texts.filter((t) => !cache.has(t)))];
  if (missing.length === 0) return;
  const vecs = await embedder(missing);
  missing.forEach((t, i) => {
    const v = vecs[i];
    if (v) cache.set(t, v);
  });
}
