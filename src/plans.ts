import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "./memory/db.js";
import { config } from "./config.js";

/**
 * Proposed actions, waiting for a person to say yes.
 *
 * The model does not execute anything it composes. When no tested recipe
 * covers a request, it writes down what it intends to do and stops; the script
 * is stored here and runs only after the user approves it, from the server,
 * outside the turn. That inverts the thing that kept going wrong: a model that
 * cannot reliably write AppleScript was nonetheless free to run whatever it
 * wrote, and to keep trying variations when they failed.
 *
 * A plan is a list of steps rather than one script. Cramming "open Notes, make
 * a note, set its body" into a single AppleScript is where the model reliably
 * goes wrong, and a list also gives the user something to read: three sentences
 * with three scripts under them, rather than one wall to consent to. Steps run
 * in order and stop at the first failure, so a half-finished plan is visible as
 * a half-finished plan instead of an error with no account of what already ran.
 *
 * Approving is a one-off. Saving promotes the steps to a named recipe, after
 * which it is *selected* rather than re-authored -- so a thing that worked once
 * keeps working, and the model never has to get the same characters right
 * twice.
 *
 * Persisted rather than held in memory so an approval survives a restart, and
 * so there is a record of what was proposed and what was allowed.
 */

export type PlanKind = "applescript" | "shell" | "python";

export const PLAN_KINDS: PlanKind[] = ["applescript", "shell", "python"];

export interface PlanStep {
  summary: string;
  script: string;
  /**
   * Missing means AppleScript, which is what every stored plan meant before
   * there was anything else.
   *
   * The other two exist because the model is measurably better at them. It
   * cannot reliably write AppleScript -- that observation is what the whole
   * recipe mechanism was built around -- while Python is one of the best
   * represented languages in any training set. Moving work down from GUI
   * scripting to a library call improves execution and *authoring* at once.
   */
  kind?: PlanKind;
}

export interface Plan {
  id: string;
  sessionId: string | null;
  summary: string;
  kind: PlanKind;
  /** JSON-encoded PlanStep[]. Stored as text so the column survives a schema
   *  that predates steps, and parsed through planSteps() which tolerates the
   *  old single-script shape. */
  payload: string;
  status: "pending" | "approved" | "declined" | "saved";
  result: string | null;
  createdAt: number;
}

/**
 * The steps of a plan, whatever shape it was stored in.
 *
 * Plans written before steps existed hold a bare script. Reading those as a
 * one-step plan costs nothing and means an approval sitting in the database
 * across an upgrade still works, rather than throwing on a JSON parse.
 */
export function planSteps(plan: Plan): PlanStep[] {
  try {
    const parsed = JSON.parse(plan.payload);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((s) => s && typeof s.script === "string")
        .map((s) => ({
          summary: String(s.summary ?? "").trim(),
          script: String(s.script),
          kind: PLAN_KINDS.includes(s.kind) ? (s.kind as PlanKind) : "applescript",
        }));
    }
  } catch {
    // Not JSON: the older single-script form.
  }
  return [{ summary: plan.summary, script: plan.payload }];
}

/**
 * The useful part of an osascript failure.
 *
 * stderr when there is one; the timeout named plainly when the process was
 * killed, because a killed process writes no stderr and `stderr ?? message`
 * passed that emptiness straight through -- the model got "Could not read
 * that: " with nothing after the colon, which teaches it nothing.
 */
export function osascriptFailure(err: unknown): string {
  const e = err as Error & { stderr?: string; killed?: boolean; signal?: string };
  if (e.stderr?.trim()) return e.stderr.trim();
  if (e.killed || e.signal === "SIGTERM") {
    return "Timed out. The window may be too complex to read; try a more specific request.";
  }
  return e.message ?? String(err);
}

const now = () => Date.now();

export function proposePlan(input: {
  sessionId?: string | null;
  summary: string;
  kind: PlanKind;
  steps: PlanStep[];
}): Plan {
  const plan: Plan = {
    id: randomUUID(),
    sessionId: input.sessionId ?? null,
    summary: input.summary.trim(),
    kind: input.kind,
    payload: JSON.stringify(input.steps),
    status: "pending",
    result: null,
    createdAt: now(),
  };

  getDb()
    .prepare(
      `INSERT INTO plans (id, session_id, summary, kind, payload, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(plan.id, plan.sessionId, plan.summary, plan.kind, plan.payload, plan.createdAt);

  return plan;
}

/**
 * Plans still waiting on a decision, with their steps already parsed.
 *
 * The approval card travels to the desktop app over the live stream and
 * nowhere else, so before this existed a restart orphaned any pending plan:
 * it sat in the database forever with no surface left to approve or decline
 * it from. A client restoring a conversation asks here for the cards to
 * re-draw.
 */
export function listPendingPlans(): Array<{
  id: string;
  sessionId: string | null;
  summary: string;
  steps: PlanStep[];
  createdAt: number;
}> {
  const rows = getDb()
    .prepare(
      `SELECT id, session_id AS sessionId, summary, kind, payload, status, result,
              created_at AS createdAt
         FROM plans WHERE status = 'pending' ORDER BY created_at ASC`,
    )
    .all() as Plan[];
  return rows.map((p) => ({
    id: p.id,
    sessionId: p.sessionId,
    summary: p.summary,
    steps: planSteps(p),
    createdAt: p.createdAt,
  }));
}

export function getPlan(id: string): Plan | null {
  const row = getDb()
    .prepare(
      `SELECT id, session_id AS sessionId, summary, kind, payload, status, result,
              created_at AS createdAt
         FROM plans WHERE id = ?`,
    )
    .get(id) as Plan | undefined;
  return row ?? null;
}

/**
 * Replace a pending plan's steps with what the user actually approved.
 *
 * The sheet is editable, so the text on screen can differ from what the model
 * proposed -- and what the user read is what they consented to. Writing it
 * back before the run keeps the record, the approval and the execution as one
 * thing rather than three versions of it.
 */
export function replacePlanSteps(id: string, steps: PlanStep[]): void {
  getDb()
    .prepare(`UPDATE plans SET payload = ? WHERE id = ? AND status = 'pending'`)
    .run(JSON.stringify(steps), id);
}

export function settlePlan(id: string, status: Plan["status"], result?: string): void {
  getDb()
    .prepare(`UPDATE plans SET status = ?, result = ?, decided_at = ? WHERE id = ?`)
    .run(status, result ?? null, now(), id);
}

/**
 * Run one script, reporting failure rather than throwing.
 *
 * Shared by approving a plan and by saving a recipe, because both obey the
 * same rule: a script is promoted to something reusable only after it has been
 * seen to work. A recipe is *selected* from then on rather than re-authored,
 * so one that never ran would be re-run verbatim forever, failing identically,
 * with nothing in the loop positioned to notice.
 */
export async function runAppleScript(
  script: string,
): Promise<{ ok: boolean; output: string }> {
  return runScript(script, "applescript");
}

/**
 * The interpreter for Python steps.
 *
 * enio's own runtime venv when it exists -- it already carries pyobjc, so a
 * Python step can reach the accessibility tree, the clipboard and everything
 * else the bridge uses. A bare python3 otherwise, so a machine without the
 * MLX runtime is not cut off from scripting entirely.
 */
function pythonPath(): string {
  const venv = join(config.runtimeDir, ".venv", "bin", "python");
  return existsSync(venv) ? venv : "python3";
}

/** Run one step by its kind. Always resolves: a failure is a result, because
 *  a plan reports where it stopped rather than throwing the turn away. */
export async function runScript(
  script: string,
  kind: PlanKind = "applescript",
): Promise<{ ok: boolean; output: string }> {
  const [command, args] =
    kind === "applescript"
      ? ["osascript", ["-e", script]]
      : kind === "python"
        ? [pythonPath(), ["-c", script]]
        : ["/bin/bash", ["-c", script]];
  try {
    const { stdout, stderr } = await promisify(execFile)(command as string, args as string[], {
      timeout: config.shellTimeoutMs,
      maxBuffer: 4_000_000,
      cwd: config.workspace,
    });
    return { ok: true, output: (stdout || stderr).trim() || "(no output)" };
  } catch (err) {
    // stderr is where a failing interpreter says what was wrong, and it is
    // routinely more useful than the exit status.
    const e = err as Error & { stderr?: string };
    if (kind === "applescript") return { ok: false, output: osascriptFailure(err) };
    return { ok: false, output: (e.stderr?.trim() || e.message || String(err)).slice(0, 4000) };
  }
}

export interface StepResult {
  step: number;
  summary: string;
  output: string;
  ok: boolean;
}

export interface ApprovalOutcome {
  status: "approved" | "saved" | "failed";
  savedAs: string | null;
  results: StepResult[];
  ranSteps: number;
  totalSteps: number;
  output: string;
}

/**
 * Run an approved plan: steps in order, stopping at the first failure.
 *
 * Promotion to a recipe happens *after* the run, and only when every step
 * succeeded. A recipe is offered to the model in a tool description from then
 * on, and the model selects rather than re-authors it — so a script that never
 * worked would be re-run verbatim forever, failing identically each time, with
 * nothing in the loop positioned to notice. "Worked once keeps working" cuts
 * both ways: only things that worked once get to be recipes.
 *
 * The plan settles even when a step fails. Approval is one-shot by design, and
 * a retry after a half-run is a new proposal — the machine may already be in a
 * state the old script's assumptions no longer match.
 */
export async function approvePlan(
  plan: Plan,
  opts: { saveAs?: string; safe?: boolean } = {},
): Promise<ApprovalOutcome> {
  const steps = planSteps(plan);
  const results: StepResult[] = [];
  let failed = false;

  for (const [i, step] of steps.entries()) {
    // Each step by its own kind: a plan may open an app with AppleScript and
    // then do the real work in Python, which is the point of having kinds.
    const run = await runScript(step.script, step.kind ?? "applescript");
    results.push({ step: i + 1, summary: step.summary, output: run.output, ok: run.ok });
    if (!run.ok) {
      failed = true;
      break;
    }
  }

  let savedAs: string | null = null;
  if (!failed && opts.saveAs) {
    // A saved recipe is one script, so a multi-step plan is joined into one.
    // Steps exist to make a plan readable and to fail in a locatable place;
    // once approved and named, it is a single thing that worked.
    // One kind per recipe: a recipe is a single script from here on, and
    // joining an AppleScript to a Python one produces something no
    // interpreter can read.
    const kinds = new Set(steps.map((s) => s.kind ?? "applescript"));
    const saved =
      kinds.size > 1
        ? { ok: false as const, reason: "mixed" }
        : saveRecipe({
            name: opts.saveAs,
            summary: plan.summary,
            script: steps.map((s) => s.script).join("\n"),
            kind: [...kinds][0] ?? "applescript",
            safe: opts.safe === true,
          });
    if (saved.ok) savedAs = saved.name;
  }

  // A plan that half-ran must say so and say where: reporting only the error
  // would leave the user unable to tell what already happened to their machine.
  const transcript = results
    .map((r) => `${r.ok ? "ok" : "failed"} — ${r.step}. ${r.summary}\n${r.output}`)
    .join("\n\n");
  settlePlan(plan.id, savedAs ? "saved" : "approved", transcript);

  return {
    status: failed ? "failed" : savedAs ? "saved" : "approved",
    savedAs,
    results,
    ranSteps: results.length,
    totalSteps: steps.length,
    output: transcript,
  };
}

/* ---------- recipes promoted from approved plans ------------------------ */

export interface SavedRecipe {
  name: string;
  summary: string;
  script: string;
  kind: PlanKind;
  /**
   * A person has vouched for this one, so it may run without asking again.
   *
   * Off unless explicitly set. Saving a recipe records that it *worked*; this
   * records that someone is willing to have it repeat unattended, which is a
   * different judgement and not one the model or the save flow can make.
   */
  safe: boolean;
}

/**
 * Names are normalised and checked rather than trusted: a saved recipe becomes
 * a selectable option in a tool description, and a name with punctuation or
 * spaces in it is one the model will fail to reproduce.
 *
 * Exported so the approval endpoint can reject a bad name *before* running the
 * plan — execution is one-shot, and finding out the name was invalid after the
 * steps have run would leave a successful run unsaveable.
 */
export function normalizeRecipeName(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return name.length >= 3 ? name : null;
}

export function saveRecipe(input: {
  name: string;
  summary: string;
  script: string;
  kind?: PlanKind;
  safe?: boolean;
}): { ok: true; name: string } | { ok: false; reason: string } {
  const name = normalizeRecipeName(input.name);
  if (!name) return { ok: false, reason: "Name is too short." };

  getDb()
    .prepare(
      `INSERT INTO saved_recipes (name, summary, script, kind, safe, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET summary = excluded.summary,
         script = excluded.script, kind = excluded.kind, safe = excluded.safe`,
    )
    .run(
      name,
      input.summary.trim(),
      input.script,
      input.kind ?? "applescript",
      input.safe ? 1 : 0,
      now(),
    );

  return { ok: true, name };
}

export function listSavedRecipes(): SavedRecipe[] {
  try {
    const rows = getDb()
      .prepare(`SELECT name, summary, script, kind, safe FROM saved_recipes ORDER BY name`)
      .all() as Array<Omit<SavedRecipe, "safe"> & { safe: number }>;
    return rows.map((r) => ({ ...r, kind: r.kind ?? "applescript", safe: r.safe === 1 }));
  } catch {
    // A missing table means an older database; no saved recipes is the correct
    // answer, not a failed turn.
    return [];
  }
}

export function forgetRecipe(name: string): boolean {
  return getDb().prepare(`DELETE FROM saved_recipes WHERE name = ?`).run(name).changes > 0;
}
