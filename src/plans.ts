import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

export type PlanKind = "applescript" | "shell";

export interface PlanStep {
  summary: string;
  script: string;
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
        .map((s) => ({ summary: String(s.summary ?? "").trim(), script: String(s.script) }));
    }
  } catch {
    // Not JSON: the older single-script form.
  }
  return [{ summary: plan.summary, script: plan.payload }];
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

export function settlePlan(id: string, status: Plan["status"], result?: string): void {
  getDb()
    .prepare(`UPDATE plans SET status = ?, result = ?, decided_at = ? WHERE id = ?`)
    .run(status, result ?? null, now(), id);
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
  opts: { saveAs?: string } = {},
): Promise<ApprovalOutcome> {
  const steps = planSteps(plan);
  const results: StepResult[] = [];
  let failed = false;

  for (const [i, step] of steps.entries()) {
    try {
      const { stdout, stderr } = await promisify(execFile)("osascript", ["-e", step.script], {
        timeout: config.shellTimeoutMs,
        maxBuffer: 4_000_000,
      });
      results.push({
        step: i + 1,
        summary: step.summary,
        output: (stdout || stderr).trim() || "(no output)",
        ok: true,
      });
    } catch (err) {
      const message = (err as Error & { stderr?: string }).stderr ?? (err as Error).message;
      results.push({ step: i + 1, summary: step.summary, output: message.trim(), ok: false });
      failed = true;
      break;
    }
  }

  let savedAs: string | null = null;
  if (!failed && opts.saveAs) {
    // A saved recipe is one script, so a multi-step plan is joined into one.
    // Steps exist to make a plan readable and to fail in a locatable place;
    // once approved and named, it is a single thing that worked.
    const saved = saveRecipe({
      name: opts.saveAs,
      summary: plan.summary,
      script: steps.map((s) => s.script).join("\n"),
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

export function saveRecipe(input: { name: string; summary: string; script: string }):
  | { ok: true; name: string }
  | { ok: false; reason: string } {
  const name = normalizeRecipeName(input.name);
  if (!name) return { ok: false, reason: "Name is too short." };

  getDb()
    .prepare(
      `INSERT INTO saved_recipes (name, summary, script, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET summary = excluded.summary, script = excluded.script`,
    )
    .run(name, input.summary.trim(), input.script, now());

  return { ok: true, name };
}

export function listSavedRecipes(): SavedRecipe[] {
  try {
    return getDb()
      .prepare(`SELECT name, summary, script FROM saved_recipes ORDER BY name`)
      .all() as SavedRecipe[];
  } catch {
    // A missing table means an older database; no saved recipes is the correct
    // answer, not a failed turn.
    return [];
  }
}

export function forgetRecipe(name: string): boolean {
  return getDb().prepare(`DELETE FROM saved_recipes WHERE name = ?`).run(name).changes > 0;
}
