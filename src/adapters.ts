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

/** The floor reply the harness gives when a turn produced nothing usable. */
const FLOOR_REPLY = /could not produce an answer/i;

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
  if (!turn.reply.trim() || FLOOR_REPLY.test(turn.reply)) return false;
  return true;
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
    if (FLOOR_REPLY.test(t.reply)) reasons.push("no usable answer");
    if (reasons.length) out.push({ turnId: t.id, question: t.question, reasons, reply: t.reply.slice(0, 160) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Clean turns of a specialist since its active adapter was trained (or
 *  ever, with none): the material --from-traces would add next time. Uses
 *  the same bar the miner does — tools used, nothing errored, nothing
 *  repaired — so the number means what it says. */
export function materialSince(specialist: string): { clean: number; since: number | null } {
  const since = activeAdapterVersion(specialist)?.trainedAt ?? null;
  const db = getDb();
  const turns = db
    .prepare(
      `SELECT id, reply, iterations FROM turns WHERE specialist = ? AND started_at > ?`,
    )
    .all(specialist, since ?? 0) as Array<{ id: number; reply: string; iterations: number }>;
  const stepsFor = db.prepare(`SELECT kind, repaired, scavenged, error FROM turn_steps WHERE turn_id = ?`);
  let clean = 0;
  for (const t of turns) {
    const steps = stepsFor.all(t.id) as Array<{ kind: string; repaired: number; scavenged: number; error: string | null }>;
    if (turnIsClean(t, steps)) clean++;
  }
  return { clean, since };
}
