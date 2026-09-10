import { getDb } from "./memory/db.js";
import { findSkill, loadSkills, type SkillSet } from "./skills.js";

/**
 * Which skills actually get used, mined from the trace tables.
 *
 * Two signals feed it: read_skill tool steps (the model deciding a skill
 * applies) and skill_invoked harness steps (the user or an ability node
 * injecting one deliberately). Uses count DISTINCT turns, not rows -- the
 * `file` parameter fires several read_skill calls inside one turn, and
 * counting rows inflated a single use three- or four-fold.
 *
 * A read_skill that answered "No skill named ..." lands in `unresolved`
 * instead: a miss cannot be attributed to a skill that does not exist, and
 * "the model keeps reaching for X, which is not installed" is itself a
 * finding worth showing. Raw names resolve through findSkill in JS -- its
 * prefix rule is deliberately not re-implemented in SQL.
 */

export interface SkillUsage {
  uses: number;
  lastUsedAt: number | null;
}

export interface UnresolvedAsk {
  name: string;
  count: number;
  lastAt: number | null;
}

export function skillUsage(set: SkillSet = loadSkills()): {
  usage: Record<string, SkillUsage>;
  unresolved: UnresolvedAsk[];
} {
  const rows = getDb()
    .prepare(
      `SELECT s.turn_id AS turnId, s.kind, s.args, s.output, t.started_at AS at
       FROM turn_steps s JOIN turns t ON t.id = s.turn_id
       WHERE (s.kind = 'tool' AND s.name = 'read_skill')
          OR (s.kind = 'harness' AND s.name = 'skill_invoked')`,
    )
    .all() as Array<{
    turnId: number;
    kind: string;
    args: string | null;
    output: string | null;
    at: number;
  }>;

  const turnsBySkill = new Map<string, Set<number>>();
  const lastBySkill = new Map<string, number>();
  // Turns, not rows, for misses too: one turn asking for a missing skill
  // three ways is one finding, and `suggest` ranks it beside per-turn
  // question clusters.
  const misses = new Map<string, { turns: Set<number>; lastAt: number }>();

  const attribute = (rawName: string, turnId: number, at: number, missed: boolean) => {
    const raw = rawName.trim();
    if (!raw) return;
    // A skill deleted since it was read also fails to resolve now -- it
    // joins the misses, which is honest: it does not exist today.
    const skill = missed ? null : findSkill(raw, set);
    if (!skill) {
      const key = raw.toLowerCase();
      const entry = misses.get(key) ?? { turns: new Set<number>(), lastAt: 0 };
      entry.turns.add(turnId);
      entry.lastAt = Math.max(entry.lastAt, at);
      misses.set(key, entry);
      return;
    }
    let turns = turnsBySkill.get(skill.name);
    if (!turns) turnsBySkill.set(skill.name, (turns = new Set()));
    turns.add(turnId);
    lastBySkill.set(skill.name, Math.max(lastBySkill.get(skill.name) ?? 0, at));
  };

  for (const row of rows) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(row.args ?? "{}") as Record<string, unknown>;
    } catch {
      continue; // an unreadable step attributes nothing rather than guessing
    }
    if (row.kind === "harness") {
      const names = Array.isArray(args.names) ? args.names : [];
      for (const name of names) attribute(String(name), row.turnId, row.at, false);
    } else {
      const missed = (row.output ?? "").startsWith("No skill named");
      attribute(String(args.name ?? ""), row.turnId, row.at, missed);
    }
  }

  const usage: Record<string, SkillUsage> = {};
  for (const [name, turns] of turnsBySkill) {
    usage[name] = { uses: turns.size, lastUsedAt: lastBySkill.get(name) ?? null };
  }
  const unresolved = [...misses.entries()]
    .map(([name, m]) => ({ name, count: m.turns.size, lastAt: m.lastAt || null }))
    .sort((a, b) => b.count - a.count);
  return { usage, unresolved };
}
