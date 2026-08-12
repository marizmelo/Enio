import { existsSync } from "node:fs";
import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { config } from "../config.js";
import { extractPdfText, looksLikePdf } from "../pdf.js";
import { activeProject, findMount } from "../project.js";
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
 * to fail a turn. Writes never take the fallback: a write target does not
 * exist yet, so it resolves in the project and stays there.
 *
 * The containment check resolves the path first and then verifies it's
 * inside the root, which is what makes it robust to `../` traversal.
 * Checking the string before resolution — the common mistake — catches
 * neither. Every root here was attached or configured by the user; nothing
 * the model does can add one.
 */
export function safePath(userPath: string): string {
  const raw = String(userPath);
  const active = activeProject();
  if (active) {
    const segments = raw.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
    const mount = segments.length > 0 ? findMount(segments[0]!) : null;
    if (mount) {
      const rest = segments.slice(1);
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

    const outRoot = resolve(active.outDir);
    const target = resolve(outRoot, raw);
    if (target === outRoot || target.startsWith(outRoot + sep)) {
      if (!existsSync(target)) {
        const wsRoot = resolve(config.workspace);
        const fallback = resolve(wsRoot, raw);
        if ((fallback === wsRoot || fallback.startsWith(wsRoot + sep)) && existsSync(fallback)) {
          return fallback;
        }
      }
      return target;
    }
    const aliases = active.attachments.map((a) => a.alias).join(", ") || "none attached";
    throw new Error(
      `Path escapes the project. Start with an attachment name (${aliases}) or use a plain relative path.`,
    );
  }

  const root = resolve(config.workspace);
  const target = resolve(root, raw);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(
      `Path escapes the workspace. Everything must live under ${root}.`,
    );
  }
  return target;
}

/** Render an absolute path the way the model addresses it: alias-relative
 *  inside a mount, plain inside the project or workspace. What a tool prints
 *  is what gets typed back, so the two must agree. */
const rel = (abs: string): string => {
  const active = activeProject();
  if (active) {
    for (const a of active.attachments) {
      if (abs === a.path) return a.alias;
      if (a.kind === "folder" && abs.startsWith(a.path + sep)) {
        return join(a.alias, relative(a.path, abs));
      }
    }
    const outDir = resolve(active.outDir);
    if (abs === outDir || abs.startsWith(outDir + sep)) return relative(outDir, abs) || ".";
  }
  return relative(config.workspace, abs) || ".";
};

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
      "Write text to a file in the working folder, creating parent directories as needed. Overwrites existing content.",
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
  },
];
