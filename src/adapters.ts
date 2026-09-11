import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, projectRoot } from "./config.js";
import { getDb } from "./memory/db.js";
import { currentModelId } from "./model-settings.js";

/**
 * The self-improvement loop's neutral core: what an adapter's history is,
 * how a trained one is installed and rolled back, and where the next
 * curriculum comes from. Nothing here trains — training is a trainer's job
 * (see trainerFor), and the trainer is the one platform-specific piece:
 * mlx_lm on a Mac today, a PEFT or llama.cpp path on Linux when that
 * hardware is chosen. Everything the loop needs besides the weights
 * themselves — versions, gate numbers, rollback, mined failures — is the
 * same on every machine, so it lives here.
 *
 * The loop is user-driven by design: nothing in it starts a training run
 * on its own. It shows what has accumulated and what failed; the person
 * decides when an hour of GPU is worth spending.
 */

export interface GateScore {
  toolRight: number;
  total: number;
  jsonValid: number;
  jsonTotal: number;
  /** Abstention probes answered honestly (absent on versions gated before
   *  the probes existed). */
  abstainRight?: number;
  abstainTotal?: number;
}

/**
 * The closed grammar of an honest "I don't have that". The gate's third
 * blind spot: it measured tool choice, JSON validity, content-not-reasoning
 * and recovery, and an adapter could have learned to answer every
 * not-on-the-map question with a confident invention while acing all four.
 * A phrase list rather than a judge model, for the reason everything here
 * is: presence in a closed list is the check this model size gets right,
 * and the judge would be the same small model grading its own humility.
 */
export const ABSTAIN_PHRASES =
  /\b(i don'?t have|i do not have|nothing (on|in|about)|no (record|mention|reference|information|trace|sign) (of|about|available)|no information|i don'?t know|not something i know|can'?t find|couldn'?t find|could not find|cannot find|unable to (find|locate)|(is|was|were) not found|not found|isn'?t (here|there|in the workspace)|is not (here|there|present|available|defined|set|configured|installed|in the workspace)|(is|are) not installed|not (set|defined|configured|mentioned) anywhere|there (is|are) no\b|does not (exist|appear)|doesn'?t (exist|appear)|no (such )?(file|function|folder)|no matches|not (in|among) the (files|workspace|project|codebase))\b/i;

/** An abstention is a reply that says so and does nothing: a tool call
 *  beside the phrase means the model is still looking, or covering. */
export function abstains(content: string | null | undefined, calledTool: boolean): boolean {
  if (calledTool) return false;
  return typeof content === "string" && ABSTAIN_PHRASES.test(content);
}

export interface AdapterVersion {
  version: number;
  trainedAt: number;
  trainer: string;
  base: string;
  rows: number;
  gate: { base: GateScore; adapter: GateScore };
  active: boolean;
}

export function adapterDir(name: string): string {
  const slug = currentModelId().replace(/\//g, "--");
  return join(config.machineStateDir, "adapters", slug, name);
}

const historyPath = (name: string) => join(adapterDir(name), "history.json");

export function adapterHistory(name: string): AdapterVersion[] {
  try {
    return JSON.parse(readFileSync(historyPath(name), "utf8")) as AdapterVersion[];
  } catch {
    return [];
  }
}

function writeHistory(name: string, entries: AdapterVersion[]): void {
  mkdirSync(adapterDir(name), { recursive: true });
  writeFileSync(historyPath(name), JSON.stringify(entries, null, 2) + "\n");
}

const WEIGHT_FILES = ["adapters.safetensors", "adapter_config.json"];

/** Copy a version's files to the registry root — the two files the server
 *  resolves (adapterPathFor) — atomically per file, so a crash mid-copy
 *  leaves a half-written directory that reads as "no adapter". */
function installFrom(name: string, from: string): void {
  const root = adapterDir(name);
  for (const f of WEIGHT_FILES) {
    copyFileSync(join(from, f), join(root, f) + ".tmp");
    renameSync(join(root, f) + ".tmp", join(root, f));
  }
}

/**
 * A trained adapter that passed the gate becomes a numbered version and the
 * installed one. Versions are kept, never overwritten: the previous one is
 * what rollback returns to, and the gate numbers are what the history is
 * for — an adapter's whole point is a measured claim.
 */
export function recordAdapterVersion(
  name: string,
  from: string,
  meta: { trainer: string; rows: number; gate: { base: GateScore; adapter: GateScore } },
): AdapterVersion {
  const history = adapterHistory(name);
  const version = (history.at(-1)?.version ?? 0) + 1;
  const dir = join(adapterDir(name), "versions", String(version));
  mkdirSync(dir, { recursive: true });
  for (const f of WEIGHT_FILES) copyFileSync(join(from, f), join(dir, f));
  const entry: AdapterVersion = {
    version,
    trainedAt: Date.now(),
    trainer: meta.trainer,
    base: currentModelId(),
    rows: meta.rows,
    gate: meta.gate,
    active: true,
  };
  writeFileSync(join(dir, "gate.json"), JSON.stringify(entry, null, 2) + "\n");
  installFrom(name, dir);
  writeHistory(name, [...history.map((h) => ({ ...h, active: false })), entry]);
  return entry;
}

/** Back to the version before the active one. The current version stays on
 *  disk — rolling back is choosing, not deleting. */
export function rollbackAdapter(name: string): { ok: boolean; version?: number; error?: string } {
  const history = adapterHistory(name);
  const activeIndex = history.findIndex((h) => h.active);
  const previous = history.slice(0, activeIndex === -1 ? history.length : activeIndex).at(-1);
  if (!previous) return { ok: false, error: "No earlier version to roll back to." };
  const dir = join(adapterDir(name), "versions", String(previous.version));
  if (!WEIGHT_FILES.every((f) => existsSync(join(dir, f)))) {
    return { ok: false, error: `Version ${previous.version}'s files are missing from disk.` };
  }
  installFrom(name, dir);
  writeHistory(name, history.map((h) => ({ ...h, active: h.version === previous.version })));
  return { ok: true, version: previous.version };
}

/** Take the adapter out of service without deleting anything: the
 *  specialist serves from the bare base until a version is chosen again. */
export function retireAdapter(name: string): boolean {
  const root = adapterDir(name);
  let removed = false;
  for (const f of WEIGHT_FILES) {
    if (existsSync(join(root, f))) {
      rmSync(join(root, f));
      removed = true;
    }
  }
  writeHistory(name, adapterHistory(name).map((h) => ({ ...h, active: false })));
  return removed;
}

export interface StagedRun {
  run: string;
  seed: string;
  at: number;
  rows: number;
  base: GateScore;
  adapter: GateScore;
  passed: boolean;
}

/** Every training run's gate numbers, newest first — the weights beside
 *  them are never deleted, because the best adapter measured was once
 *  overwritten by the next attempt. */
export function stagedRuns(name: string): StagedRun[] {
  const dir = join(adapterDir(name), "runs");
  const out: StagedRun[] = [];
  try {
    for (const run of readdirSync(dir)) {
      try {
        const g = JSON.parse(readFileSync(join(dir, run, "gate.json"), "utf8")) as Omit<StagedRun, "run">;
        if (g && g.base && g.adapter) out.push({ run, ...g, seed: String(g.seed ?? "?"), passed: Boolean(g.passed) });
      } catch {
        /* A run without a gate.json was never measured; nothing to list. */
      }
    }
  } catch {
    /* No runs yet. */
  }
  return out.sort((a, b) => b.at - a.at);
}

export function activeAdapterVersion(name: string): AdapterVersion | null {
  return adapterHistory(name).find((h) => h.active) ?? null;
}

/** Specialists with a curriculum: one scenario module each under
 *  scripts/adapter-data (lib.mjs is the shared kit, not a specialist). */
export function curriculumSpecialists(): string[] {
  try {
    return readdirSync(join(projectRoot, "scripts", "adapter-data"))
      .filter((f) => f.endsWith(".mjs") && f !== "lib.mjs")
      .map((f) => f.replace(/\.mjs$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The trainer this machine has. The one platform-specific seam in the
 * loop, named honestly: a Mac with the MLX runtime trains with mlx_lm;
 * anything else has no trainer yet, and says which hardware would decide
 * one, rather than failing somewhere inside a spawn.
 */
export function trainerFor(): { id: string; available: boolean; reason?: string } {
  if (process.platform === "darwin" && existsSync(join(config.runtimeDir, ".venv", "bin", "python"))) {
    return { id: "mlx", available: true };
  }
  if (process.platform === "darwin") {
    return { id: "mlx", available: false, reason: "The MLX runtime is not installed here — run bash install.sh." };
  }
  return {
    id: "none",
    available: false,
    reason:
      `No adapter trainer on ${process.platform} yet. The loop's registry, history, rollback and ` +
      `failure mining work here; training needs a PEFT (CUDA/ROCm) or llama.cpp trainer, chosen with the hardware.`,
  };
}

/* ---------- material: what the traces have accumulated ------------------ */

/**
 * Replies the harness or a backend authored, not the model: the floor reply
 * for a turn that produced nothing usable, and the on-device bridge's
 * refusals, which arrive as ordinary completions and are stored as the
 * turn's reply. A closed list, and it must stay one: the first version
 * matched only the floor reply, and the coder's third training run learned
 * "start a new chat" as the answer to reading a file — ten rows of it, in
 * train and valid both.
 */
const HARNESS_REPLY =
  /could not produce an answer|longer than the on-device model's window|on-device model (declined|error)|^Tool call failed:/i;

/**
 * One definition of a clean turn, shared by the material count here and
 * the miner in scripts/train-adapter.mjs: tools were used, nothing errored,
 * nothing was repaired or scavenged, the loop did not run to its cap, and
 * the reply was a real answer. The first version of the count checked only
 * the middle three and called a turn that ran out of room "clean" — which
 * would have made it training data.
 */
export function turnIsClean(
  turn: { reply: string; iterations: number },
  steps: Array<{ kind: string; repaired: number | boolean; scavenged: number | boolean; error: string | null }>,
): boolean {
  if (!steps.some((s) => s.kind === "tool")) return false;
  if (steps.some((s) => s.error || s.repaired || s.scavenged)) return false;
  if (turn.iterations >= config.maxToolIterations) return false;
  if (!turn.reply.trim() || HARNESS_REPLY.test(turn.reply)) return false;
  return true;
}

export interface MineableTurn {
  id: number;
  question: string;
  reply: string;
  iterations: number;
  startedAt: number;
  firstTool: string | null;
}

const excludedPath = (name: string) => join(adapterDir(name), "data", "excluded.json");

/** Turn ids a person struck from the material. A file beside the dataset,
 *  not a column: the traces are rebuilt by reindex, the user's judgement
 *  is not. */
export function excludedTurns(name: string): number[] {
  try {
    const parsed = JSON.parse(readFileSync(excludedPath(name), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

export function excludeTurn(name: string, id: number): number[] {
  const list = [...new Set([...excludedTurns(name), id])].sort((a, b) => a - b);
  mkdirSync(join(adapterDir(name), "data"), { recursive: true });
  writeFileSync(excludedPath(name), JSON.stringify(list) + "\n");
  return list;
}

/**
 * The turns --from-traces may learn from: clean by the bar above, produced
 * by the model the adapter is trained over, and not struck by the user.
 *
 * The model match is the lesson of the coder's third run. A 4B adapter was
 * trained on turns a 3B and Apple's on-device model had produced, because
 * nothing on a turn said which model had — 36% of the set, teaching the
 * base other models' habits. Turns recorded before the column existed have
 * no model and are never mined; the count starts again, honestly, from
 * turns this base produced. The exclusion list exists because a test
 * conversation is structurally indistinguishable from a real one: a person
 * is the filter, and `enio train material` is where they read the list.
 */
export function mineableTurns(specialist: string, since = 0): MineableTurn[] {
  const excluded = new Set(excludedTurns(specialist));
  const db = getDb();
  const turns = db
    .prepare(
      `SELECT id, question, reply, iterations, started_at AS startedAt FROM turns
        WHERE specialist = ? AND model = ? AND started_at > ? ORDER BY id DESC`,
    )
    .all(specialist, currentModelId(), since) as Array<Omit<MineableTurn, "firstTool">>;
  const stepsFor = db.prepare(
    `SELECT kind, name, repaired, scavenged, error FROM turn_steps WHERE turn_id = ? ORDER BY seq`,
  );
  const out: MineableTurn[] = [];
  for (const t of turns) {
    if (excluded.has(t.id)) continue;
    const steps = stepsFor.all(t.id) as Array<{
      kind: string; name: string | null; repaired: number; scavenged: number; error: string | null;
    }>;
    if (!turnIsClean(t, steps)) continue;
    out.push({ ...t, firstTool: steps.find((s) => s.kind === "tool")?.name ?? null });
  }
  return out;
}

export interface DatasetRow<T> {
  row: T;
  mined: boolean;
  chars: number;
}

/**
 * Train/valid membership for an adapter's rows. Valid comes from the
 * curriculum only: it is the held-out measure of the form being taught, and
 * a mined row there measures whatever conversation happened to be traced —
 * in the coder's third run, a test artefact 400 tokens over the trainer's
 * cap, which truncated its target and left the validation loss meaning
 * nothing. Rows over maxChars are dropped rather than left for the trainer
 * to truncate, because truncation takes the end of the row, which is
 * exactly the target. 12,000 characters is the 3,072-token cap at the
 * measured 4.1 characters per token of these rows, with room to spare.
 * The shuffle is seeded so membership is stable across runs.
 */
export function splitDataset<T>(
  rows: Array<DatasetRow<T>>,
  maxChars = 12_000,
): { train: T[]; valid: T[]; dropped: number; mined: number } {
  const kept = rows.filter((r) => r.chars <= maxChars);
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
  const shuffle = <U>(xs: U[]): U[] => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    return xs;
  };
  const curriculum = shuffle(kept.filter((r) => !r.mined));
  const mined = kept.filter((r) => r.mined);
  const cut = Math.max(curriculum.length - Math.max(2, Math.round(curriculum.length * 0.08)), 1);
  return {
    train: shuffle([...curriculum.slice(0, cut), ...mined]).map((r) => r.row),
    valid: curriculum.slice(cut).map((r) => r.row),
    dropped: rows.length - kept.length,
    mined: mined.length,
  };
}

export interface FailureCase {
  turnId: number;
  question: string;
  reasons: string[];
  reply: string;
}

/**
 * Turns of a specialist that went wrong in ways the traces can see: a tool
 * errored, the harness had to repair or scavenge a call, the loop ran to
 * its cap, or the reply was the honesty floor. These are the curriculum's
 * next scenarios — as candidates for a person to author, not as training
 * data. A failure is a record of the very form training is meant to remove;
 * only the corrected version of it belongs in the set.
 */
export function failureCases(specialist: string, limit = 20): FailureCase[] {
  const db = getDb();
  const turns = db
    .prepare(
      `SELECT id, question, reply, iterations FROM turns
        WHERE specialist = ? ORDER BY id DESC LIMIT 400`,
    )
    .all(specialist) as Array<{ id: number; question: string; reply: string; iterations: number }>;
  const stepsFor = db.prepare(
    `SELECT kind, name, repaired, scavenged, error FROM turn_steps WHERE turn_id = ? ORDER BY seq`,
  );
  const out: FailureCase[] = [];
  for (const t of turns) {
    const steps = stepsFor.all(t.id) as Array<{
      kind: string; name: string | null; repaired: number; scavenged: number; error: string | null;
    }>;
    const reasons: string[] = [];
    const errored = steps.filter((s) => s.kind === "tool" && s.error);
    if (errored.length) reasons.push(`tool errors: ${[...new Set(errored.map((s) => s.name))].join(", ")}`);
    if (steps.some((s) => s.repaired)) reasons.push("malformed JSON repaired");
    if (steps.some((s) => s.scavenged)) reasons.push("tool call scavenged from text");
    if (t.iterations >= config.maxToolIterations) reasons.push("ran to the iteration cap");
    if (HARNESS_REPLY.test(t.reply)) reasons.push("no usable answer");
    if (reasons.length) out.push({ turnId: t.id, question: t.question, reasons, reply: t.reply.slice(0, 160) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Clean turns of a specialist since its active adapter was trained (or
 *  ever, with none): the material --from-traces would add next time. The
 *  same list the miner reads, so the number means what it says. */
export function materialSince(specialist: string): { clean: number; since: number | null } {
  const since = activeAdapterVersion(specialist)?.trainedAt ?? null;
  return { clean: mineableTurns(specialist, since ?? 0).length, since };
}
