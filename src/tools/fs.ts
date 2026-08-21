import { existsSync } from "node:fs";
import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { config } from "../config.js";
import { extractPdfText, looksLikePdf } from "../pdf.js";
import { activeProject, findMount } from "../project.js";
import { conversationMounts, findConversationMount } from "../conversation-attachments.js";
// Safe to import: mentions.ts reaches config, project, attachments and skills,
// and none of those import back into tools/ -- checked, because a cycle here
// would surface as an undefined at call time rather than a build error.
import { workspaceFiles } from "../mentions.js";
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

/** The attached folder that IS the project, when there is exactly one and
 *  the project is a code project. Null otherwise -- several folders, none,
 *  or a general/planning project, where out/ stays the home for new files. */
function soleCodeFolder(active: NonNullable<ReturnType<typeof activeProject>>) {
  if (active.type !== "code") return null;
  const folders = active.attachments.filter((a) => a.kind === "folder");
  return folders.length === 1 ? folders[0]! : null;
}

const DOCUMENT_PATH = /\.(md|markdown|txt)$/i;
function isDocumentPath(raw: string): boolean {
  return DOCUMENT_PATH.test(raw);
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

    // A code project with exactly one attached folder: that folder IS the
    // project, and an unprefixed path roots there. Watched: asked to create
    // an app in the folder the user had just attached for that purpose, the
    // model wrote index.html, css/style.css, js/app.js -- three correct
    // write_file calls -- into the hidden out/ dir under ~/.enio, and the
    // user saw an empty folder and "files not being created". The out/ rule
    // was designed for documents, so drafts stay out of a repo; for a code
    // project with one folder it is backwards, because attaching that
    // folder was the instruction. Documents (.md/.txt) still go to out/,
    // and so does everything when there are several folders or none --
    // then "plain path" is genuinely ambiguous and out/ is the honest home.
    const sole = soleCodeFolder(active);
    if (sole && !isDocumentPath(raw)) {
      const t = resolve(sole.path, raw);
      if (t === sole.path || t.startsWith(sole.path + sep)) return t;
    }

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

/**
 * What the model probably meant, when the path it invented is not there.
 *
 * Measured, and it is the coder's largest single failure: five of six
 * `read_file` calls in the traces errored, every one a guessed path -- and
 * two of them named a file that DID exist, one folder away
 * (`library/coffee-brewing.md` for `coffee-brewing.md`). A bare ENOENT ends
 * the turn there; the basename is almost always right, so saying where that
 * name actually lives turns a dead end into the next call.
 *
 * Same shape as the mkdir refusal pointing at write_file: when the harness
 * knows the answer, the error is the place to put it. Matching is on the
 * basename only -- a fuzzy match over whole paths would invent a second
 * wrong answer, and this one is either exactly right or silent.
 */
function didYouMean(requested: string): string {
  const wanted = requested.split("/").pop()?.toLowerCase();
  if (!wanted) return "";
  let candidates: string[];
  try {
    candidates = workspaceFiles(400);
  } catch {
    return "";
  }
  const hits = candidates.filter((f) => f.split("/").pop()?.toLowerCase() === wanted).slice(0, 3);
  if (hits.length === 0) return "";
  return ` Did you mean ${hits.map((h) => `"${h}"`).join(" or ")}?`;
}

export const fsTools: ToolDef[] = [
  {
    name: "read_file",
    // "including PDFs" is load-bearing: the model's training says PDFs are
    // unreadable, and with history full of its own past failures it declared
    // "we can't view PDFs here" and fabricated instead of calling this tool.
    // The description is where a tool's abilities are learned from.
    description:
      "Read a text file or PDF from the working folder. PDF text is extracted automatically. Returns the contents with line numbers. Given a folder instead of a file, it lists what is in that folder — use that to see what exists before reading.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the working folder." },
      },
      required: ["path"],
    },
    async run(args) {
      const requested = String(args.path ?? "");
      const target = safePath(requested);

      // A path that is not there is the coder's commonest error, and the
      // basename is usually right -- so the miss carries the real location
      // rather than only the failure. Checked before the read so the message
      // is the same whatever the reason for the miss.
      if (!existsSync(target)) {
        return `Error: no file at ${rel(target)}.${didYouMean(requested)}`;
      }

      // A folder is not an error, it is a question with an obvious answer.
      // The coder does not hold list_dir -- edit_file took that slot -- so
      // reading a directory is how it sees one, which is what it reaches for
      // anyway. EISDIR taught it nothing and ended the turn.
      if ((await stat(target)).isDirectory()) {
        return await listFolder(target);
      }

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
      // What was there before, so a rewrite that loses most of a file can say
      // so. Cheap: only the line count, and only when something exists.
      const before = existsSync(target)
        ? await readFile(target, "utf8")
            .then((t) => t.split("\n").length)
            .catch(() => 0)
        : 0;
      const content = String(args.content ?? "");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      const head = `Wrote ${content.length} bytes to ${rel(target)}`;

      // write_file replaces the whole file, so a model that regenerates a
      // long file to change one line can drop the rest of it -- silently,
      // because "Wrote 412 bytes" reads like success either way. This is not
      // a refusal: rewriting IS the tool's job, and a deliberate trim would
      // trip the same check. It just makes the loss impossible to miss, to
      // the model in the result and to the person through the notice channel,
      // which is the difference between a mistake caught now and one found
      // days later. Only for files long enough for the loss to matter, and
      // only when most of it is gone -- a threshold low enough to stay quiet
      // on ordinary editing.
      const after = content.split("\n").length;
      if (before >= 20 && after < before * 0.6) {
        const lost = before - after;
        const warning =
          `${rel(target)} was ${before} lines and is now ${after} — ` +
          `${lost} lines are gone. If that was not intended, the previous ` +
          `contents are not recoverable from here; use edit_file to change ` +
          `part of a file.`;
        return { text: `${head}\n${warning}`, notice: warning };
      }
      return head;
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
    return await listFolder(safePath(String(args.path ?? ".")));
  },
};

/**
 * A folder's contents, in the one format both tools print.
 *
 * Shared because `read_file` on a directory answers with this too. The coder
 * does not hold `list_dir` -- that was the slot `edit_file` took, and nothing
 * else was droppable -- so the model's own instinct, reading the folder, is
 * made the affordance instead. It costs nothing against the tool ceiling and
 * needs no prompt line describing a tool the model cannot see.
 */
export async function listFolder(target: string): Promise<string> {
  const entries = await readdir(target, { withFileTypes: true });

  // At the project's own root, the attachments are the map: they are
  // addressed by these names, so this listing is where the model copies
  // them from. Notes ride along because "what is this for" is the whole
  // reason they exist.
  const active = activeProject();
  const mounts =
    active && target === resolve(active.outDir)
      ? active.attachments.map(
          (a) => `${a.alias}${a.kind === "folder" ? "/" : ""}${a.note ? ` — ${a.note}` : ""}`,
        )
      : [];

  if (entries.length === 0 && mounts.length === 0) return `${rel(target)} is empty.`;
  const described = await Promise.all(
    entries.slice(0, 200).map(async (e) => {
      if (e.isDirectory()) return `${e.name}/`;
      try {
        const st = await stat(join(target, e.name));
        return `${e.name} (${st.size} bytes)`;
      } catch {
        return e.name;
      }
    }),
  );
  const more = entries.length > 200 ? `\n[...${entries.length - 200} more]` : "";
  return `${rel(target)}:\n` + [...mounts, ...described].join("\n") + more;
}
