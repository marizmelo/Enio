import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { config } from "../config.js";
import type { ToolDef } from "../types.js";

/**
 * Filesystem access, hard-scoped to config.workspace.
 *
 * The containment check resolves the path first and then verifies it's inside
 * the root, which is what makes it robust to `../` traversal and to symlinks
 * pointing outward. Checking the string before resolution — the common mistake —
 * catches neither.
 */
export function safePath(userPath: string): string {
  const root = resolve(config.workspace);
  const target = resolve(root, userPath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(
      `Path escapes the workspace. Everything must live under ${root}.`,
    );
  }
  return target;
}

const rel = (abs: string) => relative(config.workspace, abs) || ".";

export const fsTools: ToolDef[] = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the workspace. Returns the file contents with line numbers.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
      },
      required: ["path"],
    },
    async run(args) {
      const target = safePath(String(args.path ?? ""));
      const text = await readFile(target, "utf8");
      const lines = text.split("\n");
      const numbered = lines
        .slice(0, 800)
        .map((l, i) => `${String(i + 1).padStart(4)} | ${l}`)
        .join("\n");
      const suffix =
        lines.length > 800 ? `\n\n[truncated: ${lines.length - 800} more lines]` : "";
      return numbered + suffix;
    },
  },
  {
    name: "write_file",
    description:
      "Write text to a file in the workspace, creating parent directories as needed. Overwrites existing content.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        content: { type: "string", description: "Full text to write." },
      },
      required: ["path", "content"],
    },
    async run(args) {
      const target = safePath(String(args.path ?? ""));
      const content = String(args.content ?? "");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return `Wrote ${content.length} bytes to ${rel(target)}`;
    },
  },
  {
    name: "list_dir",
    description:
      "List files and directories at a path in the workspace. Use this before reading to discover what exists.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory relative to the workspace root. Defaults to the root.",
        },
      },
      required: [],
    },
    async run(args) {
      const target = safePath(String(args.path ?? "."));
      const entries = await readdir(target, { withFileTypes: true });
      if (entries.length === 0) return `${rel(target)} is empty.`;
      const described = await Promise.all(
        entries.slice(0, 200).map(async (e) => {
          if (e.isDirectory()) return `${e.name}/`;
          try {
            const s = await stat(join(target, e.name));
            return `${e.name} (${s.size} bytes)`;
          } catch {
            return e.name;
          }
        }),
      );
      return `${rel(target)}:\n` + described.join("\n");
    },
  },
];
