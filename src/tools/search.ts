import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import { activeProject } from "../project.js";
import { MAX_RESULTS, searchProject, type SearchHit } from "../project-index.js";
import { workspaceFiles } from "../mentions.js";
import type { ToolDef } from "../types.js";

const execFileAsync = promisify(execFile);

/**
 * One search tool, query in, ranked locations out -- the shape DECISIONS.md
 * prescribes for "read a whole codebase" (a tree-walker plus a grepper plus
 * a symbol index would be three tools against a sixteen-tool ceiling).
 *
 * Always offered: with a project open it searches the attached folders
 * through the per-project index (FTS5 + live ripgrep); without one it greps
 * the workspace. Either way the paths printed are exactly the paths
 * read_file accepts, because the model copies paths far more reliably than
 * it composes them.
 */

/**
 * Files whose NAME matches, which content search cannot find.
 *
 * With a project open the index covers paths, so "greet.ts" locates the file.
 * The workspace path was ripgrep over contents only, so the same query
 * answered "No matches" for a file sitting right there -- and that is the
 * measured failure this whole seam exists for: five of six coder `read_file`
 * calls in the traces were invented paths, because nothing cheap told it
 * where a named file lived.
 *
 * Name hits come FIRST and are labelled, because a line number would be a
 * lie: nothing was matched inside the file.
 */
function nameMatches(query: string): SearchHit[] {
  const needle = query.toLowerCase().trim();
  if (!needle) return [];
  let files: string[];
  try {
    files = workspaceFiles(400);
  } catch {
    return [];
  }
  return files
    .filter((f) => {
      const base = f.split("/").pop()!.toLowerCase();
      return base === needle || base.includes(needle) || f.toLowerCase() === needle;
    })
    // An exact basename first: "app.js" should not be buried under
    // "app.js.map" and "old-app.js".
    .sort((a, b) => {
      const exact = (f: string) => (f.split("/").pop()!.toLowerCase() === needle ? 0 : 1);
      return exact(a) - exact(b) || a.length - b.length;
    })
    .slice(0, 5)
    .map((path) => ({ path, line: 0, snippet: "" }));
}

async function searchWorkspace(query: string): Promise<SearchHit[]> {
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["-n", "--no-heading", "-S", "-m", String(MAX_RESULTS), "--", query],
      { cwd: config.workspace, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => /^(.+?):(\d+):(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({
        path: m[1]!,
        line: Number(m[2]),
        snippet: m[3]!.replace(/\s+/g, " ").trim().slice(0, 160),
      }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return []; // rg ran: no matches
  }
  // No ripgrep on this machine: a plain walk. The workspace is small by
  // construction, so this stays cheap.
  const hits: SearchHit[] = [];
  const lower = query.toLowerCase();
  const walk = (dir: string) => {
    if (hits.length >= MAX_RESULTS) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        if (statSync(full).size > 512 * 1024) continue;
        const lines = readFileSync(full, "utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.toLowerCase().includes(lower)) {
            hits.push({
              path: relative(config.workspace, full),
              line: i + 1,
              snippet: lines[i]!.replace(/\s+/g, " ").trim().slice(0, 160),
            });
            break;
          }
        }
      } catch {
        /* binary or unreadable: skip */
      }
      if (hits.length >= MAX_RESULTS) return;
    }
  };
  walk(config.workspace);
  return hits;
}

export const searchTools: ToolDef[] = [
  {
    name: "search_code",
    description:
      "Search file contents across the working folders and return ranked path:line locations. " +
      "Use this to find where something is defined, used, or mentioned before reading files.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to search for. Plain words work best.",
        },
      },
      required: ["query"],
    },
    async run(args) {
      const query = String(args.query ?? "").trim();
      if (!query) return "Error: no query given.";

      const project = activeProject();
      // Without a project, names are matched here rather than by the grep,
      // which only sees contents. With one, the index already covers paths.
      const named = project ? [] : nameMatches(query);
      const found = project ? await searchProject(project, query) : await searchWorkspace(query);
      // A file already named by a name-hit does not need a content line too.
      const content = found.filter((h) => !named.some((n) => n.path === h.path));
      const where = project ? `project "${project.name}"` : "the workspace";
      if (named.length === 0 && content.length === 0) {
        return `No matches for "${query}" in ${where}.`;
      }

      const parts: string[] = [];
      if (named.length > 0) {
        parts.push(
          `Files named like "${query}" in ${where}:\n` + named.map((h) => h.path).join("\n"),
        );
      }
      if (content.length > 0) {
        parts.push(
          `Matches in ${where} (path:line):\n` +
            content.map((h) => `${h.path}:${h.line}: ${h.snippet}`).join("\n"),
        );
      }
      return parts.join("\n\n");
    },
  },
];
