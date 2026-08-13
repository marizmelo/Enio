import { execSync } from "node:child_process";
import { totalmem } from "node:os";

/**
 * The models Enio offers to download, as a closed list.
 *
 * Closed for two reasons. The obvious one is the same reason everything else
 * here is a closed list: choosing from a handful is a decision this project
 * can make well, and an id typed by hand is a five-gigabyte download of
 * something that may not load. The other is that the download endpoint takes
 * its argument from an HTTP request, and "fetch whatever repo id you are
 * given" is a general-purpose downloader pointed at the user's disk. Only ids
 * that appear here are accepted, so the endpoint can only ever fetch something
 * on this page.
 *
 * Every entry was checked against the Hugging Face API rather than recalled:
 * the repo exists, `bytes` is the actual sum of its files, and its chat
 * template mentions tools. That last one is the check that matters most and
 * the one that is invisible without doing it -- a model with no tool support
 * in its template loads fine, chats fine, and never calls a single tool, which
 * reads as Enio being broken rather than as the wrong model. gemma-3-4b was
 * dropped from this list for exactly that reason.
 */

export interface CatalogueModel {
  id: string;
  /** What the picker shows. The repo id is unreadable at a glance. */
  label: string;
  /** Total download, measured from the repo rather than estimated. */
  bytes: number;
  /** One line on what it is for, in the picker. */
  note: string;
  /** Whether its speed and tool use were measured *in Enio*, as opposed to
   *  the model merely being known to load. Surfaced so the list does not
   *  imply more confidence than there is. */
  measured?: boolean;
  /** Bytes actually read per generated token, when that is less than the
   *  download -- mixture-of-experts models touch only their active experts.
   *  Dense models omit it and the download size is the answer. */
  activeBytes?: number;
}

const GB = 1_000_000_000;

export const CATALOGUE: CatalogueModel[] = [
  {
    id: "mlx-community/Qwen3-1.7B-4bit",
    label: "Qwen3 1.7B",
    bytes: 0.98 * GB,
    note: "Smallest that still routes and calls tools. For 8GB machines.",
  },
  {
    id: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
    label: "Qwen3 4B Instruct (default)",
    bytes: 2.28 * GB,
    note: "The out-of-the-box model. Measured here: routed 8/8 at 426ms median.",
    measured: true,
  },
  {
    id: "mlx-community/Llama-3.2-3B-Instruct-4bit",
    label: "Llama 3.2 3B",
    bytes: 1.82 * GB,
    note: "Small and quick. Shorter context than the Qwen3 models.",
  },
  {
    id: "mlx-community/Qwen3-8B-4bit",
    label: "Qwen3 8B",
    bytes: 4.62 * GB,
    note: "Better at multi-step tool use, at roughly half the speed of 4B.",
  },
  {
    id: "mlx-community/Qwen2.5-7B-Instruct-4bit",
    label: "Qwen2.5 7B Instruct",
    bytes: 4.3 * GB,
    note: "The older generation. Steadier, no thinking mode.",
  },
  {
    id: "mlx-community/Mistral-7B-Instruct-v0.3-4bit",
    label: "Mistral 7B Instruct",
    bytes: 4.08 * GB,
    note: "Strong plain prose. Weaker at picking tools than the Qwen3 models.",
  },
  {
    id: "mlx-community/Qwen3-14B-4bit",
    label: "Qwen3 14B",
    bytes: 8.32 * GB,
    note: "Noticeably better judgement. Wants 24GB and patience.",
  },
  {
    id: "mlx-community/Qwen3-30B-A3B-4bit",
    label: "Qwen3 30B A3B",
    bytes: 17.19 * GB,
    note: "Mixture of experts: 3B active, so quicker than its size suggests.",
    // ~3.3B of 30.5B parameters touched per token; the rest of the experts
    // sit resident but unread. This is the number that makes MoE the answer
    // to the bandwidth wall, and why speed cannot be read off the download.
    activeBytes: 1.9 * GB,
  },
];

export function catalogueModel(id: string): CatalogueModel | undefined {
  return CATALOGUE.find((m) => m.id === id);
}

/**
 * Roughly what a model needs resident to answer, in bytes.
 *
 * Weights are the download, near enough -- the repo is safetensors and little
 * else. On top of that sits the KV cache, the runtime, and everything the
 * machine was already doing, and on Apple Silicon all of it competes for the
 * same unified memory, so a model that "fits in RAM" on paper is one that
 * makes the whole desktop swap.
 *
 * A derived rule rather than a number written beside each model, so adding an
 * entry cannot silently forget to say how much memory it wants.
 */
const KV_AND_RUNTIME = 1.25;
const MACHINE_HEADROOM = 3 * GB;

export function footprint(bytes: number): number {
  return bytes * KV_AND_RUNTIME + MACHINE_HEADROOM;
}

export type Fit = "fits" | "tight" | "over";

/**
 * Whether this machine can run a model of that size, and how comfortably.
 *
 * Three answers rather than two because the honest failure here is gradual.
 * A model slightly too large does not refuse to load: macOS swaps, tokens
 * arrive every few seconds, and the machine becomes unpleasant to use --
 * which reads as Enio being slow rather than as a choice that can be undone.
 * Saying so beforehand costs one line; discovering it costs a 17GB download
 * and a wedged laptop.
 *
 * Advisory in both directions. Nothing here blocks a download, because the
 * numbers are a rule of thumb and the person knows things this does not --
 * that they will quit their other apps, that the machine is headless, that
 * they want it anyway.
 */
export function fitFor(bytes: number, machineBytes = totalmem()): Fit {
  const needed = footprint(bytes);
  if (needed > machineBytes) return "over";
  if (needed > machineBytes * 0.75) return "tight";
  return "fits";
}

export function machineMemory(): number {
  return totalmem();
}

/* ------------------------------------------------------- speed, honestly */

/**
 * Memory bandwidth per Apple Silicon chip, GB/s.
 *
 * The article-length version: on this hardware, capacity decides whether a
 * model LOADS and bandwidth decides whether it is USABLE -- generation
 * reads every active weight once per token, so tokens/second is bounded by
 * bandwidth over bytes-per-token. A dense 70B fits on a 64GB machine and
 * then generates ~4 tok/s: a model you watch, not one you use. fitFor()
 * answers the first question; this table answers the second.
 *
 * Where a chip ships in more than one memory configuration, the number here
 * is the LOWEST -- an estimate that flatters the hardware teaches the exact
 * mistake this exists to prevent.
 */
const CHIP_BANDWIDTH_GBPS: Record<string, number> = {
  "Apple M1": 68, "Apple M1 Pro": 200, "Apple M1 Max": 400, "Apple M1 Ultra": 800,
  "Apple M2": 100, "Apple M2 Pro": 200, "Apple M2 Max": 400, "Apple M2 Ultra": 800,
  "Apple M3": 100, "Apple M3 Pro": 150, "Apple M3 Max": 300, "Apple M3 Ultra": 800,
  "Apple M4": 120, "Apple M4 Pro": 273, "Apple M4 Max": 410,
};

let cachedChip: string | null | undefined;

/** The chip name as macOS reports it, cached; null off-macOS or unknown. */
export function machineChip(): string | null {
  if (cachedChip !== undefined) return cachedChip;
  try {
    cachedChip = execSync("sysctl -n machdep.cpu.brand_string", { timeout: 2000 })
      .toString()
      .trim() || null;
  } catch {
    cachedChip = null;
  }
  return cachedChip;
}

/** Decode throughput lands well under the theoretical bandwidth ceiling --
 *  attention, cache traffic and the runtime all eat share. 0.6 matches
 *  measured MLX decode rates on M-series within the tolerance an estimate
 *  deserves; it is a rule of thumb, and is labelled as one everywhere it
 *  surfaces. */
const DECODE_EFFICIENCY = 0.6;

export interface SpeedEstimate {
  /** Rounded tokens/second, or null when the chip is unknown. */
  tokensPerSecond: number | null;
  /** The honest sentence: responsive / usable / "you'll watch it". */
  pace: "fast" | "usable" | "slow" | null;
}

/**
 * Estimated generation speed for a catalogue model on this machine.
 *
 * Null on an unknown chip rather than a guess: no number beats a wrong
 * number, and the fit column still works. Advisory like fitFor -- nothing
 * blocks a download.
 */
export function speedFor(
  model: Pick<CatalogueModel, "bytes" | "activeBytes">,
  chip: string | null = machineChip(),
): SpeedEstimate {
  const bandwidth = chip ? CHIP_BANDWIDTH_GBPS[chip] : undefined;
  if (!bandwidth) return { tokensPerSecond: null, pace: null };
  const bytesPerToken = model.activeBytes ?? model.bytes;
  const tps = Math.round(((bandwidth * GB) / bytesPerToken) * DECODE_EFFICIENCY);
  return {
    tokensPerSecond: tps,
    pace: tps >= 25 ? "fast" : tps >= 10 ? "usable" : "slow",
  };
}

/** What "try a bigger local model" concretely means on this machine. */
export interface Upgrade {
  id: string;
  label: string;
  tokensPerSecond: number | null;
  pace: SpeedEstimate["pace"];
}

/**
 * The private half of "this answer wasn't enough": a catalogue model that is
 * genuinely more capable than the current one AND that this machine runs at
 * a pace someone would sit through. Null when no such model exists, and the
 * menu item is withheld rather than greyed -- most base machines hit the
 * bandwidth wall long before they hit the capacity wall, and "download a
 * bigger model" is a mirage there. Advice this specific is only worth giving
 * when it is true.
 *
 * Capability is ordered by total bytes -- the same proxy the catalogue is
 * sorted by. Crude, but it agrees with every pairwise comparison in the
 * list, and inventing a capability score would imply a measurement nobody
 * made. A current model not in the catalogue (Maple, a hand-rolled server)
 * compares as smaller than everything, which is the right bias for the one
 * model that actually ships that way.
 */
export function recommendUpgrade(
  currentId: string | null,
  machineBytes = totalmem(),
  chip: string | null = machineChip(),
): Upgrade | null {
  const current = currentId ? catalogueModel(currentId) : undefined;
  const floor = current?.bytes ?? 0;
  const candidates = CATALOGUE.filter((m) => {
    if (m.id === currentId || m.bytes <= floor) return false;
    if (fitFor(m.bytes, machineBytes) === "over") return false;
    const { pace } = speedFor(m, chip);
    // An unknown chip yields no estimate, and recommending an unmeasured
    // wait is how this feature would lie. Slow is an answer: withhold.
    return pace === "fast" || pace === "usable";
  });
  if (candidates.length === 0) return null;
  const best = candidates.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  const speed = speedFor(best, chip);
  return {
    id: best.id,
    label: best.label,
    tokensPerSecond: speed.tokensPerSecond,
    pace: speed.pace,
  };
}
