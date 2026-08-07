import type { ToolDef } from "../types.js";
import { findSkill, loadSkills, skillContents, skillFile } from "../skills.js";

/**
 * One tool for the entire skills system.
 *
 * The `file` parameter is what keeps it to one slot: without it, reading a
 * skill's reference material would need a second tool, and against a 16-tool
 * ceiling that doubling is not affordable.
 */
export const skillTools: ToolDef[] = [
  {
    name: "read_skill",
    description:
      "Load the full instructions for one of the available skills before doing the work it describes. Pass `file` as well to read one of that skill's reference documents.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill's name, exactly as listed." },
        file: {
          type: "string",
          description:
            "Optional. A path within the skill, e.g. 'references/style-guide.md', listed at the end of the skill body.",
        },
      },
      required: ["name"],
    },
    async run(args) {
      const requested = String(args.name ?? "").trim();
      if (!requested) return "Error: which skill?";

      const set = loadSkills();
      const skill = findSkill(requested, set);
      if (!skill) {
        const available = set.skills.map((s) => s.name).join(", ") || "none installed";
        return `No skill named "${requested}". Available: ${available}`;
      }

      if (args.file) {
        try {
          return skillFile(skill, String(args.file));
        } catch (err) {
          const contents = skillContents(skill);
          return (
            `${(err as Error).message}\n` +
            (contents.length ? `This skill contains: ${contents.join(", ")}` : "")
          );
        }
      }

      const parts = [`# Skill: ${skill.name}\n`, skill.body];

      const contents = skillContents(skill);
      if (contents.length > 0) {
        // The absolute path is here so scripts can actually be run — the shell
        // tool's working directory is the workspace, not the skill folder.
        parts.push(
          `\n---\nThis skill's folder is ${skill.dir}\n` +
            `Additional files: ${contents.join(", ")}\n` +
            `Read one with read_skill(name="${skill.name}", file="..."), ` +
            `or run a script with its full path.`,
        );
      }

      if (skill.allowedTools?.length) {
        parts.push(`\nUse only these tools for this task: ${skill.allowedTools.join(", ")}`);
      }

      return parts.join("\n");
    },
  },
];
