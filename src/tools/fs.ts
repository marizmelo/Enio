import { existsSync } from "node:fs";
import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { config } from "../config.js";
import { extractPdfText, looksLikePdf } from "../pdf.js";
import { activeProject, findMount } from "../project.js";
import { conversationMounts, findConversationMount } from "../conversation-attachments.js";
import type { ToolDef } from "../types.js";

/**
 * Filesystem access, hard-scoped to roots the user granted.
 *
 * With no project open that is config.workspace, exactly as it always was.
 * With a project open, a path's first segment may name an attachment alias
 * ("api/src/x.ts" reads inside the attached folder whose alias is "api");
 * anything unprefixed roots in the project's out dir, so generated files
 * live and die with the project instead of piling into the global
 * workspace. Unprefixed reads fall back to the global workspace when the
 * file exists there and not in the project -- conversation attachments land
 * in the workspace whatever is open, and an attachment must never be able
 * to fail a turn. Writes never take the fallback -- by option, not by
 * accident: the old claim was "a write target does not exist yet", which
 * is false for an existing workspace file, and write_file("shot.png") with
 * a project open would have overwritten the conversation's attachment. A
 * write resolves in the project and stays there.
 *
 * The containment check resolves the path first and then verifies it's
 * inside the root, which is what makes it robust to `../` traversal.
 * Checking the string before resolution — the common mistake — catches
 * neither. Every root here was attached or configured by the user; nothing
 * the model does can add one.
 */
/** Resolve a path inside one mount, with the containment check. Shared by
 *  project and conversation mounts — the alias grammar is identical, only
 *  who granted the mount differs. */
function resolveInMount(mount: { alias: string; path: string; kind: string }, rest: string[]): string {
  if (mount.kind === "file") {
    if (rest.length > 0) {
      throw new Error(`${mount.alias} is an attached file, not a folder.`);
    }
    return mount.path;
  }
  const root = mount.path;
  const target = resolve(root, rest.join(sep));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Path escapes the attached folder "${mount.alias}".`);
  }
  return target;
}

export function safePath(userPath: string, opts: { forWrite?: boolean } = {}): string {
  const raw = String(userPath);
  const active = activeProject();
  const segments = raw.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
  if (active) {
    // Project mounts first, conversation mounts second: the project is the
    // context the user deliberately opened, so its names win a collision
    // (attach-time deduping means new collisions cannot happen; this order
    // covers a project attached after the conversation took the name).
    const mount =
      segments.length > 0
        ? (findMount(segments[0]!) ?? findConversationMount(segments[0]!))
        : null;
    if (mount) return resolveInMount(mount, segments.slice(1));

    const outRoot = resolve(active.outDir);
    const target = resolve(outRoot, raw);
    if (target === outRoot || target.startsWith(outRoot + sep)) {
      if (!opts.forWrite && !existsSync(target)) {
        const wsRoot = resolve(config.workspace);
        const fallback = resolve(wsRoot, raw);
        if ((fallback === wsRoot || fallback.startsWith(wsRoot + sep)) && existsSync(fallback)) {
          return fallback;
        }
      }
      return target;
    }
    const aliases =
      [...active.attachments, ...conversationMounts()].map((a) => a.alias).join(", ") ||
      "none attached";
    throw new Error(
      `Path escapes the project. Start with an attachment name (${aliases}) or use a plain relative path.`,
    );
  }

  const conversationMount =
    segments.length > 0 ? findConversationMount(segments[0]!) : null;
  if (conversationMount) return resolveInMount(conversationMount, segments.slice(1));

  const root = resolve(config.workspace);
  const target = resolve(root, raw);
  if (target !== root && !target.startsWith(root + sep)) {
    const aliases = conversationMounts().map((a) => a.alias).join(", ");
    throw new Error(
      `Path escapes the workspace. Everything must live under ${root}` +
        (aliases ? `, or start with an attachment name (${aliases}).` : `.`),
    );
  }
  return target;
}

/** Render an absolute path the way the model addresses it: alias-relative
 *  inside a mount, plain inside the project or workspace. What a tool prints
 *  is what gets typed back, so the two must agree. */
const rel = (abs: string): string => {
  const active = activeProject();
  // Same precedence as safePath — project mounts, then conversation mounts —
  // so what a tool prints is exactly what resolves back.
  const mountLists = [active?.attachments ?? [], conversationMounts()];
  for (const list of mountLists) {
    for (const a of list) {
      if (abs === a.path) return a.alias;
      if (a.kind === "folder" && abs.startsWith(a.path + sep)) {
        return join(a.alias, relative(a.path, abs));
      }
    }
  }
  if (active) {
    const outDir = resolve(active.outDir);
    if (abs === outDir || abs.startsWith(outDir + sep)) return relative(outDir, abs) || ".";
  }
  return relative(config.workspace, abs) || ".";
};

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

/** read_file prints `NNNN | line`. If every line of a passage carries that
 *  prefix, return the passage without it; otherwise return it unchanged. */
const GUTTER = /^\s*\d+ \| /;
function stripGutter(s: string): string {
  const lines = s.split("\n");
  const body = lines.length > 1 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  if (body.length === 0 || !body.every((l) => GUTTER.test(l))) return s;
  const stripped = body.map((l) => l.replace(GUTTER, ""));
  return stripped.join("\n") + (body.length < lines.length ? "\n" : "");
}

export const fsTools: ToolDef[] = [
  {
    name: "read_file",
    // "including PDFs" is load-bearing: the model's training says PDFs are
    // unreadable, and with history full of its own past failures it declared
    // "we can't view PDFs here" and fabricated instead of calling this tool.
    // The description is where a tool's abilities are learned from.
    description:
      "Read a text file or PDF from the working folder. PDF text is extracted automatically. Returns the contents with line numbers.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the working folder." },
      },
      required: ["path"],
    },
    async run(args) {
      const target = safePath(String(args.path ?? ""));

      // Binary must become real text or an honest refusal -- never bytes.
      // A PDF read as UTF-8 decodes to pages of mojibake that burn the
      // context budget and prime the model to invent what the document
      // "must" say instead of admitting it could not read it.
      const head = await readFile(target).then((b) => b.subarray(0, 8192));
      if (looksLikePdf(head)) {
        const pdf = await extractPdfText(target);
        if (!pdf) return `${rel(target)} is a PDF that could not be parsed.`;
        if (!pdf.text) {
          return (
            `${rel(target)} is a scanned PDF (${pdf.pages} page${pdf.pages === 1 ? "" : "s"}, ` +
            `no text layer), so there is no text to extract.`
          );
        }
        const clipped =
          pdf.text.length > 24_000 ? pdf.text.slice(0, 24_000) + "\n[...truncated]" : pdf.text;
        return `${rel(target)} (PDF, ${pdf.pages} page${pdf.pages === 1 ? "" : "s"}), extracted text:\n\n${clipped}`;
      }
      if (head.includes(0)) {
        const size = (await stat(target)).size;
        return (
          `${rel(target)} is a binary file (${size} bytes). It cannot be read as text -- ` +
          `say so rather than guessing at its contents.`
        );
      }

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
      "Create a file, or replace a whole file's contents, in the working folder. Creates parent directories. For a change inside an existing file use edit_file instead.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the working folder." },
        content: { type: "string", description: "Full text to write." },
      },
      required: ["path", "content"],
    },
    async run(args) {
      const target = safePath(String(args.path ?? ""), { forWrite: true });
      const content = String(args.content ?? "");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return `Wrote ${content.length} bytes to ${rel(target)}`;
    },
  },
  {
    name: "edit_file",
    description:
      "Replace one exact passage in an existing file. old_string must appear exactly once — copy it verbatim from read_file output, WITHOUT the line-number gutter. To create a file or rewrite it whole, use write_file.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the working folder." },
        old_string: {
          type: "string",
          description: "The exact text to replace. Include enough surrounding lines that it occurs once.",
        },
        new_string: { type: "string", description: "The text to put in its place." },
      },
      required: ["path", "old_string", "new_string"],
    },
    async run(args) {
      const target = safePath(String(args.path ?? ""), { forWrite: true });
      const shown = rel(target);
      if (!existsSync(target)) {
        throw new Error(`No file at ${shown}. Use write_file to create a new file.`);
      }
      const buf = await readFile(target);
      if (buf.subarray(0, 8000).includes(0) || looksLikePdf(buf)) {
        throw new Error(`${shown} is binary; edit_file only edits text.`);
      }
      const text = buf.toString("utf8");
      const oldRaw = String(args.old_string ?? "");
      const newRaw = String(args.new_string ?? "");
      if (oldRaw.length === 0) throw new Error("old_string is empty — say what to replace.");

      // Literal first. The gutter strip is a fallback for the one mistake
      // the tool description cannot prevent at this model size: copying
      // old_string out of read_file's numbered output, gutter included. It
      // is applied only on a miss and only when EVERY line carries the
      // gutter, so real content that happens to look like "  12 | x" on
      // one line is never mangled.
      let oldStr = oldRaw;
      let count = occurrences(text, oldStr);
      let stripped = false;
      if (count === 0 && stripGutter(oldRaw) !== oldRaw) {
        oldStr = stripGutter(oldRaw);
        count = occurrences(text, oldStr);
        stripped = count > 0;
      }
      // new_string is stripped only when old_string was: the model copies
      // both in the same dialect, and a literal old_string that matched as
      // written says the dialect was plain -- so a new_string that merely
      // LOOKS like a gutter line is content, and stays.
      const newStr = stripped ? stripGutter(newRaw) : newRaw;

      if (count === 0) {
        throw new Error(
          `old_string was not found in ${shown}. Read the file and copy the passage exactly, without line numbers.`,
        );
      }
      if (count > 1) {
        throw new Error(
          `old_string matches ${count} times in ${shown}; include more surrounding lines so it matches once.`,
        );
      }
      const at = text.indexOf(oldStr);
      const next = text.slice(0, at) + newStr + text.slice(at + oldStr.length);
      await writeFile(target, next, "utf8");
      const line = text.slice(0, at).split("\n").length;
      // First line in write_file's dialect: the artifact regex and the
      // canvas reload key off it, and one grammar for every writer is the
      // rule (handoff_saved speaks it too).
      return `Wrote ${Buffer.byteLength(next)} bytes to ${shown}\nReplaced 1 passage at line ${line}.`;
    },
  }
];

/**
 * list_dir lives outside fsTools on purpose: nothing assigns it to a routed
 * specialist any more (the coder traded it for edit_file -- search_code
 * indexes paths and `run_command ls` lists a folder), and in single-agent
 * mode it is the tool worth losing to the 16-tool ceiling. Registered last
 * so that when the ceiling truncates the end of the list, THIS falls off
 * rather than web_search -- the silent capability loss the pipelines suite
 * caught as "web-search ability does not exist".
 */
export const listDirTool: ToolDef = {
    name: "list_dir",
    description:
      "List files and directories at a path in the working folder. Use this before reading to discover what exists.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory relative to the working folder. Defaults to the root.",
        },
      },
      required: [],
    },
    async run(args) {
      const target = safePath(String(args.path ?? "."));
      const entries = await readdir(target, { withFileTypes: true });

      // At the project's own root, the attachments are the map: they are
      // addressed by these names, so this listing is where the model copies
      // them from. Notes ride along because "what is this for" is the whole
      // reason they exist.
      const active = activeProject();
      const mounts =
        active && target === resolve(active.outDir)
          ? active.attachments.map((a) =>
              `${a.alias}${a.kind === "folder" ? "/" : ""}${a.note ? ` — ${a.note}` : ""}`,
            )
          : [];

      if (entries.length === 0 && mounts.length === 0) return `${rel(target)} is empty.`;
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
      return `${rel(target)}:\n` + [...mounts, ...described].join("\n");
    },
  };

