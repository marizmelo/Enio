import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname } from "node:path";
import { sendJson } from "../http-util.js";
import { loadSkills, skillsDir } from "../skills.js";
import { skillUsage } from "../skill-usage.js";

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
    const globalRoot = skillsDir();
    const skills = [
      ...set.skills.map((s) => ({
        name: s.name,
        description: s.description,
        manualOnly: s.manualOnly,
        source: s.dir.startsWith(globalRoot) ? "global" : "project",
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
  return false;
}
