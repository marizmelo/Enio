import { execFile } from "node:child_process";
import { homedir } from "node:os";
import type { ToolDef } from "../types.js";

/**
 * Finding a file on the machine by name — Spotlight, scoped to names.
 *
 * "Where is my tax PDF" was unanswerable: every filesystem tool is
 * hard-scoped to the workspace, which protects CONTENTS and writes — but a
 * name is not a content, and macOS keeps an index of every name already.
 * mdfind answers from that index in milliseconds, honors the system's own
 * privacy exclusions, and reads nothing.
 *
 * The tool returns paths and nothing else, on purpose: read_file still
 * refuses anything outside the granted roots, so finding a file and
 * reading it stay two different acts, the second one the user's. The
 * search is pinned to the home directory (-onlyin), and the arguments go
 * through execFile as an array — no shell ever sees the query.
 *
 * It lives on the librarian for the same reason the memory tools do: a
 * specialist with no web access and no shell, so a filename can reach the
 * reply and nowhere else.
 */

const MAX_RESULTS = 40;

export interface FindFileDeps {
  run?: (bin: string, args: string[]) => Promise<string>;
}

const defaultRun = (bin: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

export function findFileTool(deps: FindFileDeps = {}): ToolDef {
  const run = deps.run ?? defaultRun;
  return {
    name: "find_file",
    description:
      "Find files and folders on this Mac by name (Spotlight). Returns paths only, " +
      "never contents — to read one, ask the user to attach it or add it to the " +
      "conversation. Use when the user asks where a file is or whether one exists.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Part of the file or folder name, e.g. 'tax-2024' or 'resume.pdf'.",
        },
      },
      required: ["query"],
    },
    async run(args) {
      const query = String(args.query ?? "").trim();
      if (!query) return "Error: say what filename to look for.";
      if (query.length > 100) return "Error: that query is too long for a filename search.";

      const home = homedir();
      let out: string;
      try {
        out = await run("mdfind", ["-onlyin", home, "-name", query]);
      } catch (err) {
        return `Error: Spotlight search failed (${(err as Error).message}).`;
      }

      const paths = out
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (paths.length === 0) {
        return `No files or folders named like "${query}" under ${home}. Spotlight only sees what it has indexed.`;
      }

      const capped = paths.slice(0, MAX_RESULTS);
      const shown = capped.map((p) => p.replace(home, "~"));
      const more = paths.length > MAX_RESULTS ? `\n…and ${paths.length - MAX_RESULTS} more.` : "";
      return {
        text:
          `${paths.length} match${paths.length === 1 ? "" : "es"}:\n` +
          shown.join("\n") +
          more +
          `\n\nThese are locations only. To work with one, the user can attach it to the conversation.`,
        // The desktop draws these as rows with Open and Show in Finder —
        // user clicks, never model calls; the text above stands alone
        // everywhere else.
        widget: { type: "found_files", paths: capped },
      };
    },
  };
}
