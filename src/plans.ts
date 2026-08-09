import { randomUUID } from "node:crypto";
import { getDb } from "./memory/db.js";

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
 * Approving is a one-off. Saving promotes the script to a named recipe, after
 * which it is *selected* rather than re-authored -- so a thing that worked once
 * keeps working, and the model never has to get the same characters right
 * twice.
 *
 * Persisted rather than held in memory so an approval survives a restart, and
 * so there is a record of what was proposed and what was allowed.
 */

export type PlanKind = "applescript" | "shell";

export interface Plan {
  id: string;
  sessionId: string | null;
  summary: string;
  kind: PlanKind;
  payload: string;
  status: "pending" | "approved" | "declined" | "saved";
  result: string | null;
  createdAt: number;
}

const now = () => Date.now();

export function proposePlan(input: {
  sessionId?: string | null;
  summary: string;
  kind: PlanKind;
  payload: string;
}): Plan {
  const plan: Plan = {
    id: randomUUID(),
    sessionId: input.sessionId ?? null,
    summary: input.summary.trim(),
    kind: input.kind,
    payload: input.payload,
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
 */
export function saveRecipe(input: { name: string; summary: string; script: string }):
  | { ok: true; name: string }
  | { ok: false; reason: string } {
  const name = input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (name.length < 3) return { ok: false, reason: "Name is too short." };

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
