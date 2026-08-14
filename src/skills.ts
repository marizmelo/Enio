import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { config, projectRoot } from "./config.js";
import { activeProject } from "./project.js";

/**
 * Skills: reusable know-how, as opposed to tools, which are capability.
 *
 * A tool lets the model send an email. A skill tells it how *you* want emails
 * written. Both are needed, and neither substitutes for the other.
 *
 * The mechanism is progressive disclosure, and it's the same insight that made
 * specialists work: keep the visible menu short, load detail only on demand.
 * Every installed skill contributes one line (~30-50 tokens) to the system
 * prompt. The full body — typically 1-2k tokens — loads only when the model
 * decides the skill applies.
 *
 * That's why this costs exactly ONE tool slot no matter how many skills are
 * installed, which matters a great deal against a 16-tool ceiling. Adding the
 * same capability via MCP would cost a slot per server.
 *
 * Format follows the SKILL.md convention so skills written for other agents
 * work here unmodified.
 */

export interface Skill {
  name: string;
  description: string;
  /** Absolute path to the skill's folder, so its scripts can be run. */
  dir: string;
  /** Body of SKILL.md with the frontmatter stripped. */
  body: string;
  /** Optional: restricts which tools the skill's instructions may use. */
  allowedTools: string[] | null;
  /** Optional: excluded from the catalogue; only reachable by explicit name. */
  manualOnly: boolean;
  /** Which root it was loaded from. */
  origin: SkillOrigin;
  /** True when this is a user copy standing in front of a shipped skill of
   *  the same name — the state that needs saying out loud, because from then
   *  on upstream improvements no longer reach it. */
  overridesBuiltin: boolean;
}

export interface SkillProblem {
  path: string;
  reason: string;
}

export interface SkillSet {
  skills: Skill[];
  problems: SkillProblem[];
}

export const skillsDir = (): string => join(config.dataDir, "skills");

/**
 * The skills that ship with enio, read from the repo rather than copied out
 * of it.
 *
 * Copying was the original design and it froze them: `cpSync` with
 * force:false never overwrites, so a skill improved upstream never reached
 * anyone who had already installed it, and nothing on disk said whether a
 * file was stock or edited. Reading them live means `git pull` updates them,
 * which is the only way an improvement can arrive. Same shape as the
 * pipeline example library, which has always read its shipped dir directly.
 */
export const builtinSkillsDir = (): string =>
  // Overridable so a test can isolate it BY NAME rather than by accident --
  // the machineStateDir lesson. These now live in the checkout, which every
  // test inherits, so a suite that redirects only ENIO_DATA_DIR would still
  // load the shipped catalogue into every prompt it measures.
  process.env.ENIO_BUILTIN_SKILLS ?? join(projectRoot, "examples", "skills");

/** Built-in, then global, then the active project's -- iterated in that
 *  order so a later root shadows an earlier one by name. That is what makes
 *  a user's own copy of a built-in win (their intent is the more specific
 *  one), and what makes project skills vanish when the project closes. */
export function skillRoots(): string[] {
  const roots = [builtinSkillsDir(), skillsDir()];
  const project = activeProject();
  if (project) roots.push(join(project.dir, "skills"));
  return roots;
}

/** Where a skill came from — the distinction the panel needs to label a row
 *  and the edit path needs to decide whether to copy before writing. */
export type SkillOrigin = "builtin" | "global" | "project";

export function skillOrigin(dir: string): SkillOrigin {
  if (dir.startsWith(builtinSkillsDir() + sep)) return "builtin";
  if (dir.startsWith(skillsDir() + sep)) return "global";
  return "project";
}

/**
 * Loaded fresh on each call rather than cached.
 *
 * Editing a skill and having it take effect on the next message — without
 * restarting — is most of what makes them pleasant to iterate on. At a few
 * dozen small files the read cost is irrelevant next to a single model call.
 * Being uncached is also what makes project skills free: the roots are
 * re-derived per call, so opening or closing a project changes the set with
 * no caller involved.
 */
export function loadSkills(): SkillSet {
  const byName = new Map<string, Skill>();
  const problems: SkillProblem[] = [];

  for (const root of skillRoots()) {
    if (!existsSync(root)) continue;

    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch (err) {
      problems.push({ path: root, reason: (err as Error).message });
      continue;
    }

    for (const entry of entries.sort()) {
      const dir = join(root, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }

      const file = join(dir, "SKILL.md");
      if (!existsSync(file)) {
        problems.push({ path: dir, reason: "no SKILL.md" });
        continue;
      }

      try {
        const skill = parseSkill(readFileSync(file, "utf8"), dir, entry);
        // Later roots override: the map write is the shadowing rule. What is
        // recorded here is that it HAPPENED, so the panel can say so.
        skill.overridesBuiltin = byName.get(skill.name)?.origin === "builtin";
        byName.set(skill.name, skill);
      } catch (err) {
        // One malformed skill must not take the others down with it.
        problems.push({ path: file, reason: (err as Error).message });
      }
    }
  }

  return { skills: [...byName.values()], problems };
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkill(source: string, dir: string, fallbackName: string): Skill {
  const match = FRONTMATTER.exec(source.replace(/^﻿/, ""));
  if (!match) {
    throw new Error("missing YAML frontmatter (a --- delimited block at the top)");
  }

  let meta: Record<string, unknown>;
  try {
    meta = (parseYaml(match[1]!) ?? {}) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`invalid YAML frontmatter: ${(err as Error).message}`);
  }

  const name = String(meta.name ?? fallbackName).trim();
  const description = String(meta.description ?? "").trim();

  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(
      `invalid name "${name}" — lowercase letters, digits and hyphens only, max 64 chars`,
    );
  }
  if (!description) {
    // Without this the model has no basis for choosing the skill, so it would
    // sit in the catalogue as dead weight forever.
    throw new Error("missing 'description' — it is what tells the model when to use this");
  }

  const allowed = meta["allowed-tools"] ?? meta.allowedTools;
  return {
    name,
    description,
    dir,
    body: (match[2] ?? "").trim(),
    allowedTools: Array.isArray(allowed) ? allowed.map(String) : null,
    manualOnly:
      meta["disable-model-invocation"] === true || meta.disableModelInvocation === true,
    origin: skillOrigin(dir),
    // Set by loadSkills, which is the only place that can see a collision.
    overridesBuiltin: false,
  };
}

/**
 * The one-line-per-skill catalogue injected into the system prompt.
 *
 * Capped, because the whole point is that this stays cheap. Past a few dozen
 * entries a small model stops discriminating between them and the catalogue
 * becomes noise that crowds out retrieved memory.
 */
const MAX_CATALOGUE = 40;

export function skillCatalogue(set: SkillSet = loadSkills()): string {
  const listed = set.skills.filter((s) => !s.manualOnly).slice(0, MAX_CATALOGUE);
  if (listed.length === 0) return "";

  const lines = listed.map((s) => `- ${s.name}: ${s.description}`);
  const overflow = set.skills.filter((s) => !s.manualOnly).length - listed.length;
  if (overflow > 0) lines.push(`- (${overflow} more, not shown)`);

  return (
    `Skills available. When one applies, call read_skill with its name to get ` +
    `the full instructions BEFORE doing the work:\n${lines.join("\n")}`
  );
}

export function findSkill(name: string, set: SkillSet = loadSkills()): Skill | null {
  const wanted = name.trim().toLowerCase();
  return (
    set.skills.find((s) => s.name.toLowerCase() === wanted) ??
    // Small models paraphrase names; a prefix match recovers the turn more
    // often than an error does.
    set.skills.find((s) => s.name.toLowerCase().startsWith(wanted)) ??
    null
  );
}

/**
 * A skill's SKILL.md by NAME, for the editor — never by path.
 *
 * The resolveNote rule, applied here: the caller says which skill, the
 * server decides which file. A folder name with a separator or a dot segment
 * is refused outright rather than sanitised, and the resolved path is checked
 * back against its root, so no request can address anything but a SKILL.md
 * directly inside a skill root.
 *
 * Unlike findSkill this works on BROKEN skills too — the folder is scanned
 * rather than the parsed set — because the editor exists precisely to fix a
 * SKILL.md whose frontmatter no longer parses.
 */
export function resolveSkillFile(name: string): { file: string; dir: string } | null {
  return resolveSkillIn(skillRoots(), name);
}

/** The same resolution against one root — what "is there a user copy" and
 *  "is there a built-in behind it" both need to ask separately. */
export function resolveSkillIn(
  roots: string[],
  name: string,
): { file: string; dir: string } | null {
  const wanted = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(wanted) || wanted.includes("..")) return null;
  // Reversed, because skillRoots() is ordered least-specific first (that is
  // what makes the loader's shadowing work) and resolution wants the winner:
  // the project copy over the global one over the built-in.
  for (const root of [...roots].reverse()) {
    const dir = resolve(root, wanted);
    // The regex already forbids separators, so this cannot fail -- it is the
    // second lock, kept because the first is a pattern someone may loosen.
    if (!dir.startsWith(root + sep)) continue;
    const file = join(dir, "SKILL.md");
    if (existsSync(file)) return { file, dir };
  }
  return null;
}

/** Reference files a skill can pull in on demand, relative to its folder. */
export function skillFile(skill: Skill, relative: string): string {
  const target = resolve(skill.dir, relative);
  if (target !== skill.dir && !target.startsWith(skill.dir + sep)) {
    throw new Error("path escapes the skill folder");
  }
  if (!existsSync(target)) throw new Error(`no such file in this skill: ${relative}`);
  return readFileSync(target, "utf8");
}

/** Listing what's alongside SKILL.md is what makes references discoverable. */
export function skillContents(skill: Skill): string[] {
  const found: string[] = [];
  for (const sub of ["references", "scripts", "assets"]) {
    const dir = join(skill.dir, sub);
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir).sort()) found.push(`${sub}/${f}`);
    } catch {
      /* unreadable subfolder is not fatal */
    }
  }
  return found;
}
