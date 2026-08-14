import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readBody, sendJson } from "../http-util.js";
import {
  builtinSkillsDir,
  loadSkills,
  parseSkill,
  resolveSkillFile,
  resolveSkillIn,
  skillOrigin,
  skillsDir,
} from "../skills.js";
import { skillUsage } from "../skill-usage.js";

/** The editor's cap. A SKILL.md is prose the model reads every turn; past
 *  this it is a document that belongs in the skill's references folder. */
const MAX_SOURCE_BYTES = 256 * 1024;

/**
 * The Skills tab's read: what know-how is installed, where it came from,
 * whether it gets used. Read-only on purpose -- a skill is the user's
 * document, edited in their editor, and the panel is a window onto that,
 * not a second editor to keep consistent with the first.
 */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/skills") {
    const set = loadSkills();
    const { usage, unresolved } = skillUsage(set);
    const skills = [
      ...set.skills.map((s) => ({
        name: s.name,
        description: s.description,
        manualOnly: s.manualOnly,
        origin: s.origin,
        overridesBuiltin: s.overridesBuiltin,
        dir: s.dir,
        broken: false as const,
        usage: usage[s.name] ?? { uses: 0, lastUsedAt: null },
      })),
      // A broken skill is a row, not a hidden log line: the folder name is
      // the only identity a file that failed to parse can offer.
      ...set.problems.map((p) => ({
        name: basename(p.path) === "SKILL.md" ? basename(dirname(p.path)) : basename(p.path),
        dir: basename(p.path) === "SKILL.md" ? dirname(p.path) : p.path,
        broken: true as const,
        reason: p.reason,
      })),
    ];
    sendJson(res, 200, { skills, unresolved });
    return true;
  }

  /**
   * The source of one SKILL.md, for the canvas editor.
   *
   * Addressed by NAME — the closed-list rule the whole codebase runs on. The
   * client never sends a path, so there is nothing to traverse; the server
   * resolves the file inside a skill root or answers 404.
   */
  const source = /^\/skills\/([^/]+)\/source$/.exec(url.pathname);
  if (source) {
    const name = decodeURIComponent(source[1]!);
    const found = resolveSkillFile(name);
    if (!found) {
      sendJson(res, 404, { error: { message: `No skill named "${name}".` } });
      return true;
    }

    if (req.method === "GET") {
      try {
        const content = readFileSync(found.file, "utf8");
        sendJson(res, 200, {
          name,
          dir: found.dir,
          content,
          mtime: statSync(found.file).mtimeMs,
        });
      } catch (err) {
        sendJson(res, 500, { error: { message: (err as Error).message } });
      }
      return true;
    }

    /** Reset to built-in: drop the user's copy so the shipped one shows
     *  through again — and starts tracking updates again with it. Only ever
     *  removes a file in the GLOBAL dir, and only when a built-in of the
     *  same name exists to fall back to, so this cannot delete the only
     *  copy of anything. */
    if (req.method === "DELETE") {
      const mine = resolveSkillIn([skillsDir()], name);
      const builtin = resolveSkillIn([builtinSkillsDir()], name);
      if (!mine || !builtin) {
        sendJson(res, 409, {
          error: { message: "There is no built-in version of this skill to go back to." },
        });
        return true;
      }
      try {
        rmSync(mine.dir, { recursive: true, force: true });
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 500, { error: { message: (err as Error).message } });
      }
      return true;
    }

    if (req.method === "PUT") {
      let body: { content?: string };
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        sendJson(res, 400, { error: { message: "Invalid JSON." } });
        return true;
      }
      const content = String(body.content ?? "");
      if (Buffer.byteLength(content, "utf8") > MAX_SOURCE_BYTES) {
        sendJson(res, 413, { error: { message: "Too large for a SKILL.md." } });
        return true;
      }
      // The gate that makes an editor safe here: a skill's identity lives in
      // its frontmatter, and a save that breaks it would drop the skill out
      // of the catalogue -- the failure being invisible is the whole problem.
      // Same shape as saving a recipe, which runs the script first: refuse
      // the write rather than store something that cannot work.
      try {
        parseSkill(content, found.dir, name);
      } catch (err) {
        sendJson(res, 422, {
          error: { message: `Not saved — ${(err as Error).message}` },
        });
        return true;
      }
      // Copy-on-write. A built-in lives in the repo, which `git pull`
      // overwrites -- editing it there would lose the change at the next
      // update AND make the repo dirty. So the first edit becomes the user's
      // own copy, which then shadows it; Reset removes that copy again.
      let target = found.file;
      if (skillOrigin(found.dir) === "builtin") {
        const mine = join(skillsDir(), name);
        mkdirSync(mine, { recursive: true });
        target = join(mine, "SKILL.md");
      }
      try {
        writeFileSync(target, content, "utf8");
        sendJson(res, 200, {
          ok: true,
          mtime: statSync(target).mtimeMs,
          // True when this save just created the override, so the panel can
          // say what happened rather than silently changing the row's label.
          forked: target !== found.file,
        });
      } catch (err) {
        sendJson(res, 500, { error: { message: (err as Error).message } });
      }
      return true;
    }
  }

  return false;
}
