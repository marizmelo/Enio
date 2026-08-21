import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { config } from "./config.js";
import { activeProject } from "./project.js";
import { conversationMounts } from "./conversation-attachments.js";
import { loadSkills, type Skill } from "./skills.js";
import { allSpecialists } from "./specialists.js";
import type { Registry } from "./tools/index.js";

/**
 * `/skill` and `@mention` syntax.
 *
 * Two escapes from the model's judgement, which matters when the model is
 * small: the router picks a specialist and the model decides whether a skill
 * applies, and both are exactly the kind of choice a ~1B-active model gets
 * wrong. When you already know the answer, saying so directly is better than
 * rephrasing until it guesses right.
 *
 *   /commit-message              load a skill's instructions, guaranteed
 *   @coder review this           force a specialist
 *   summarise @notes/plan.md     attach a workspace file
 *   @github what changed         allow an MCP server's tools this turn
 *
 * Unrecognised mentions are left as ordinary text. That rule is what makes this
 * safe to apply to every message: an email address or a decorator must never be
 * silently eaten, and a typo should read as a typo rather than doing something
 * unexpected.
 */

export interface Mentions {
  /** The message with recognised mentions removed. */
  text: string;
  /** Skills to load in full before the turn starts, in the order written. */
  skills: Skill[];
  /** Overrides the router for this turn. */
  specialist: string | null;
  /** Workspace-relative paths to attach. */
  files: string[];
  /** MCP servers whose tools are permitted this turn regardless of specialist. */
  servers: string[];
  /** Mentions that looked deliberate but matched nothing. */
  unresolved: string[];
}

export interface MentionContext {
  skillNames: string[];
  specialists: string[];
  servers: string[];
  files: string[];
  /** The file pinned in the desktop's canvas, if any. What "@canvas" means
   *  for this turn -- supplied by the client, never inferred. */
  canvasPath?: string | null;
}

/** Everything that can be mentioned, for both resolution and tab completion. */
export function mentionContext(registry?: Registry): MentionContext {
  const skills = loadSkills().skills.map((s) => s.name);
  const servers = registry
    ? [...new Set(registry.all.filter((t) => t.server).map((t) => t.server!))]
    : [];
  return {
    skillNames: skills,
    specialists: allSpecialists().map((s) => s.name),
    servers,
    files: workspaceFiles(),
  };
}

/** Shallow-ish listing, capped — this feeds tab completion, not a file browser.
 *  With a project open, its attachments come first under their alias names —
 *  the same names every other tool addresses them by — then the workspace. */
export function workspaceFiles(max = 400): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number, base: string, prefix: string) => {
    if (out.length >= max || depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1, base, prefix);
        else out.push(prefix + relative(base, full));
      } catch {
        /* vanished between readdir and stat */
      }
      if (out.length >= max) return;
    }
  };
  const project = activeProject();
  // Project mounts, then conversation mounts, then the project's own
  // storage, then the workspace — the same precedence safePath resolves
  // with. out/ was missing entirely: documents the agent generated with
  // plain paths landed there and appeared in no listing anywhere, which
  // read as "files not being created". They are addressed unprefixed, so a
  // name held by both out/ and the workspace is listed once and resolves to
  // out/ — safePath's own collision rule.
  const mounts = [...(project?.attachments ?? []), ...conversationMounts()];
  for (const a of mounts) {
    if (out.length >= max) break;
    if (a.kind === "file") out.push(a.alias);
    else walk(a.path, 0, a.path, a.alias + "/");
  }
  if (project) walk(project.outDir, 0, project.outDir, "");
  walk(config.workspace, 0, config.workspace, "");
  return [...new Set(out)].sort();
}

/** Just the project's own storage — what workspaceFiles merged in
 *  unprefixed. Listed separately too, so the Browse tree can label these
 *  "project" rather than letting generated documents masquerade as
 *  workspace files. */
export function generatedFiles(max = 200): string[] {
  const project = activeProject();
  if (!project) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number, base: string) => {
    if (out.length >= max || depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1, base);
        else out.push(relative(base, full));
      } catch {
        /* vanished between readdir and stat */
      }
      if (out.length >= max) return;
    }
  };
  walk(project.outDir, 0, project.outDir);
  return out.sort();
}

/**
 * A slash command is only recognised as the very first token.
 *
 * Anywhere else a slash is a path separator or a date, and treating those as
 * commands would be constant false positives.
 */
const SLASH = /^\/([a-z0-9][a-z0-9-]*)\s*/i;

/**
 * An @mention must be preceded by start-of-string or whitespace, which is what
 * keeps `user@example.com` and `@decorator` in code from being consumed.
 */
const AT = /(^|\s)@([A-Za-z0-9][\w./-]*)/g;

export function parseMentions(raw: string, ctx: MentionContext): Mentions {
  const result: Mentions = {
    text: raw,
    skills: [],
    specialist: null,
    files: [],
    servers: [],
    unresolved: [],
  };

  const allSkills = loadSkills().skills;

  const slash = SLASH.exec(raw);
  if (slash) {
    const wanted = slash[1]!.toLowerCase();
    const skill =
      allSkills.find((s) => s.name.toLowerCase() === wanted) ??
      allSkills.find((s) => s.name.toLowerCase().startsWith(wanted));
    if (skill) {
      result.skills.push(skill);
      result.text = raw.slice(slash[0].length);
    }
    // An unmatched slash is left alone: the REPL's own commands (/help, /good)
    // are handled before this ever runs.
  }

  // Set when @canvas resolved; applied after the pass so an explicit
  // @agent anywhere in the message still wins.
  let canvasWantsEditor = false;

  result.text = result.text.replace(AT, (match, lead: string, token: string) => {
    const lower = token.toLowerCase();

    // "@canvas" is the pinned document, named by what the user is looking at
    // rather than by the path they would otherwise have to type -- and the
    // panel beside the thread shows exactly which file that is. Resolved to
    // the real path here, so the stored transcript stays readable and no
    // client has to know which agent owns write_file.
    if (lower === "canvas" && ctx.canvasPath) {
      if (!result.files.includes(ctx.canvasPath)) result.files.push(ctx.canvasPath);
      canvasWantsEditor = true;
      return `${lead}${ctx.canvasPath}`;
    }

    if (ctx.specialists.includes(lower)) {
      result.specialist = lower;
      return lead;
    }
    if (ctx.servers.some((s) => s.toLowerCase() === lower)) {
      result.servers.push(ctx.servers.find((s) => s.toLowerCase() === lower)!);
      return lead;
    }

    const file =
      ctx.files.find((f) => f === token) ??
      ctx.files.find((f) => f.toLowerCase() === lower);
    if (file) {
      result.files.push(file);
      // The filename stays in the text so the sentence still reads naturally
      // and the model knows which attachment is being discussed.
      return `${lead}${file}`;
    }

    // Looks like a mention, matched nothing. Keep the text verbatim and report
    // it, so a typo produces a hint rather than silence.
    if (!token.includes("@") && !token.includes(".") ) result.unresolved.push(token);
    return match;
  });

  // Editing the pinned file needs the agent that holds write_file; an
  // explicit mention beats it, so "@researcher @canvas ..." still asks the
  // researcher about the document rather than rewriting it.
  if (canvasWantsEditor && !result.specialist) result.specialist = "coder";

  result.text = result.text.trim();
  return result;
}

/** Candidate completions for the token being typed. */
export function completeMention(line: string, ctx: MentionContext): [string[], string] {
  const slashAtStart = /^\/([a-z0-9-]*)$/i.exec(line);
  if (slashAtStart) {
    const prefix = slashAtStart[1]!.toLowerCase();
    const hits = ctx.skillNames.filter((n) => n.startsWith(prefix)).map((n) => `/${n}`);
    return [hits.length ? hits : ctx.skillNames.map((n) => `/${n}`), line];
  }

  const at = /(?:^|\s)@([\w./-]*)$/.exec(line);
  if (at) {
    const prefix = at[1]!.toLowerCase();
    const all = [
      ...ctx.specialists.map((s) => `@${s}`),
      ...ctx.servers.map((s) => `@${s}`),
      ...ctx.files.map((f) => `@${f}`),
    ];
    const hits = all.filter((c) => c.slice(1).toLowerCase().startsWith(prefix));
    return [hits.length ? hits : all, `@${at[1]}`];
  }

  return [[], line];
}

/**
 * Skills invoked with a slash are injected whole rather than offered via
 * read_skill. The point of asking explicitly is to remove a decision, and
 * making the model call a tool to get what you already told it to use would
 * put the decision straight back.
 */
export function invokedSkillBlock(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return skills
    .map(
      (s) =>
        `The user invoked the "${s.name}" skill. Follow these instructions:\n\n${s.body}` +
        (s.allowedTools?.length ? `\n\nUse only: ${s.allowedTools.join(", ")}` : ""),
    )
    .join("\n\n---\n\n");
}
