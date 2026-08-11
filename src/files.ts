import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { config } from "./config.js";
import { safePath } from "./tools/fs.js";
import { listConversations } from "./memory/store.js";

/**
 * What is on disk, and whose it is.
 *
 * Attachments used to land in the top level of the workspace beside the files
 * a person actually works on, uniquified by a counter -- screenshot.png,
 * screenshot-2.png, screenshot-3.png -- so a workspace became a junk drawer
 * within a week, with nothing recording which conversation any of it belonged
 * to. Attaching is a per-conversation act and the storage now says so.
 *
 * They stay *inside* the workspace, in a subfolder, because the filesystem
 * tools are hard-scoped there by safePath: an attachment somewhere else could
 * not be read by the agent at all. The subfolder buys the grouping without
 * touching that boundary.
 */

export const ATTACH_DIR = "attachments";

export interface FileEntry {
  /** Workspace-relative, which is also what an @mention uses. */
  path: string;
  name: string;
  bytes: number;
  modified: number;
  image: boolean;
}

export interface ConversationFiles {
  id: string;
  /** Null when the conversation has been discarded but its files have not. */
  title: string | null;
  bytes: number;
  files: FileEntry[];
}

export interface Storage {
  totalBytes: number;
  workspace: FileEntry[];
  conversations: ConversationFiles[];
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;

/** Where this conversation's attachments live. */
export function attachmentDir(conversationId: string): string {
  // Through safePath even though the id comes from our own database: it also
  // arrives from an HTTP body on the delete path, and one function that is
  // always safe beats two that are safe in different ways.
  return safePath(join(ATTACH_DIR, conversationId));
}

function entry(absolute: string): FileEntry | null {
  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) return null;
    const path = relative(config.workspace, absolute);
    return {
      path,
      name: path.split(sep).pop() ?? path,
      bytes: stat.size,
      modified: stat.mtimeMs,
      image: IMAGE.test(path),
    };
  } catch {
    return null;
  }
}

function filesIn(dir: string): FileEntry[] {
  if (!existsSync(dir)) return [];
  const out: FileEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const found = entry(join(dir, name));
    if (found) out.push(found);
  }
  return out.sort((a, b) => b.modified - a.modified);
}

/**
 * Everything the workspace holds, split by what owns it.
 *
 * A conversation that has been discarded still appears, with a null title,
 * rather than being hidden or silently swept: the files are real and are using
 * real disk, and a storage screen that omits some of what is stored is worse
 * than no storage screen. It is also the only place they can now be found --
 * the conversation that named them is gone.
 */
export function listStorage(): Storage {
  const root = config.workspace;
  const workspace = existsSync(root)
    ? readdirSync(root)
        .filter((name) => !name.startsWith(".") && name !== ATTACH_DIR)
        .flatMap((name) => {
          const full = join(root, name);
          try {
            // One level down for ordinary folders, so a workspace with a
            // project in it is not reported as a single opaque row.
            return statSync(full).isDirectory() ? filesIn(full) : [entry(full)].filter(Boolean);
          } catch {
            return [];
          }
        })
        .filter((f): f is FileEntry => f !== null)
    : [];

  const titles = new Map(listConversations(500).map((c) => [c.id, c.title]));
  const attachRoot = join(root, ATTACH_DIR);
  const conversations: ConversationFiles[] = [];

  if (existsSync(attachRoot)) {
    for (const id of readdirSync(attachRoot)) {
      if (id.startsWith(".")) continue;
      const files = filesIn(join(attachRoot, id));
      if (files.length === 0) continue;
      conversations.push({
        id,
        title: titles.get(id) ?? null,
        bytes: files.reduce((sum, f) => sum + f.bytes, 0),
        files,
      });
    }
  }

  // Newest activity first, matching the conversation list this sits beside.
  conversations.sort((a, b) => newest(b.files) - newest(a.files));

  const totalBytes =
    workspace.reduce((sum, f) => sum + f.bytes, 0) +
    conversations.reduce((sum, c) => sum + c.bytes, 0);

  return { totalBytes, workspace, conversations };
}

function newest(files: FileEntry[]): number {
  return files.reduce((max, f) => Math.max(max, f.modified), 0);
}

/** Attachment paths only, for a client that needs to resolve an @mention to
 *  one without listing every attachment in its file menu. */
export function attachmentPaths(): string[] {
  return listStorage().conversations.flatMap((c) => c.files.map((f) => f.path));
}

export class FileRefused extends Error {}

/**
 * Delete one attachment copy, or one conversation's whole attachment folder.
 *
 * Attachments only, and that is the boundary that matters: an attachment is
 * *enio's copy* — attaching copies the chosen file into the workspace, so
 * removing the copy removes enio's reference and the user's original, wherever
 * it lives, is never touched. Everything else in the workspace is the user's
 * actual work, and a permanent delete of it reachable from an HTTP body is an
 * irreversible action nobody opted into. Those files are removed where the
 * user's own files are always removed: in Finder, which the storage screen
 * can reveal them in, and which has a Trash.
 *
 * Deliberately not recursive over arbitrary paths either: a single file, or a
 * directory that is specifically one conversation's attachments. "Delete this
 * directory tree" is a bigger capability than anything this screen needs.
 */
export function removeFile(relPath: string): number {
  const absolute = safePath(relPath);
  const parts = relative(config.workspace, absolute).split(sep);
  if (parts[0] !== ATTACH_DIR || parts.length < 2) {
    throw new FileRefused(
      "Only attachment copies can be deleted here — that file is your own work. Use Show in Finder to manage it.",
    );
  }
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    throw new FileRefused(`${relPath} is not there`);
  }
  if (stat.isDirectory()) {
    if (parts.length !== 2) {
      throw new FileRefused("Only a conversation's attachment folder can be removed whole");
    }
    const bytes = filesIn(absolute).reduce((sum, f) => sum + f.bytes, 0);
    rmSync(absolute, { recursive: true, force: true });
    return bytes;
  }
  rmSync(absolute, { force: true });
  return stat.size;
}

/** Everything a conversation attached, removed with it. Returns bytes freed. */
export function removeConversationFiles(conversationId: string): number {
  const dir = join(ATTACH_DIR, conversationId);
  try {
    return removeFile(dir);
  } catch {
    // Nothing was attached, which is the common case. Not a failure.
    return 0;
  }
}
