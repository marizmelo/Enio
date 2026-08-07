import { config } from "../config.js";

/**
 * Local embeddings via transformers.js (ONNX). Runs in-process, no Python, no
 * network after the first download (~130MB, cached in ~/.cache/huggingface).
 *
 * Loading is lazy and memoised: the model costs a couple of seconds to
 * initialise and we don't want to pay that on commands that never embed
 * anything.
 */

type Extractor = (
  text: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<Extractor> | null = null;
let warnedUnavailable = false;

async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      // Never phone home for anything already on disk.
      env.allowLocalModels = true;
      const pipe = await pipeline("feature-extraction", config.embeddingModel, {
        dtype: "fp32",
      });
      return pipe as unknown as Extractor;
    })();
  }
  return extractorPromise;
}

/**
 * Returns L2-normalised vectors. On failure (no model cached and no network)
 * returns null rather than throwing — semantic recall is an enhancement, and
 * losing it should degrade the agent, not break it.
 */
export async function embed(text: string): Promise<Float32Array | null> {
  const batch = await embedBatch([text]);
  return batch[0] ?? null;
}

export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];
  try {
    const extractor = await getExtractor();
    const cleaned = texts.map((t) => t.replace(/\s+/g, " ").trim().slice(0, 2000) || " ");
    const output = await extractor(cleaned, { pooling: "mean", normalize: true });
    return output.tolist().map((row) => Float32Array.from(row));
  } catch (err) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.error(
        `\n[memory] Embeddings unavailable (${(err as Error).message}). ` +
          `Falling back to keyword-only recall.\n`,
      );
    }
    return texts.map(() => null);
  }
}

export async function embeddingsWork(): Promise<boolean> {
  return (await embed("probe")) !== null;
}
