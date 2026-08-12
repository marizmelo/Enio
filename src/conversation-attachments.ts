import { resolve } from "node:path";
import { getDb } from "./memory/db.js";
import {
  activeProject,
  assertAttachable,
  checkCap,
  dedupedAlias,
  type Attachment,
} from "./project.js";

/**
 * Standing attachments scoped to one conversation.
 *
 * The same idea as a project's attachments — user-granted roots the tools
 * may read, addressed by alias — but riding the session row instead of a
 * project folder, because not every conversation deserves a project. The
 * symmetry is deliberate: same Attachment shape, same refusals
 * (assertAttachable), same note cap, same alias rules. What differs is
 * precedence: when a project is open its aliases win, so a conversation
 * attachment can never shadow the project the user deliberately opened.
 *
 * Only the user adds one — the routes are authed HTTP and nothing in the
 * tool registry touches this module. That is the projects invariant
 * extended: the sandbox is something the user grants, never something the
 * model widens.
 */

function readList(sessionId: string): Attachment[] {
  const row = getDb()
    .prepare(`SELECT attachments FROM sessions WHERE id = ?`)
    .get(sessionId) as { attachments: string | null } | undefined;
  if (!row?.attachments) return [];
  try {
    const parsed = JSON.parse(row.attachments);
    return Array.isArray(parsed) ? (parsed as Attachment[]) : [];
  } catch {
    // A corrupt list degrades to no attachments, never to a failed turn.
    return [];
  }
}

function writeList(sessionId: string, list: Attachment[]): void {
  const changed = getDb()
    .prepare(`UPDATE sessions SET attachments = ? WHERE id = ?`)
    .run(JSON.stringify(list), sessionId).changes;
  if (changed === 0) throw new Error(`No conversation ${sessionId}.`);
}

export function listConversationAttachments(sessionId: string): Attachment[] {
  return readList(sessionId);
}

export function attachToConversation(sessionId: string, path: string, note = ""): Attachment {
  const trimmedNote = note.trim();
  checkCap("note", trimmedNote);
  const { real, kind } = assertAttachable(resolve(path));

  const list = readList(sessionId);
  if (list.some((a) => a.path === real)) {
    throw new Error(`Already attached to this conversation as "${list.find((a) => a.path === real)!.alias}".`);
  }

  // Deduped against the open project's aliases too: resolution gives the
  // project first claim on a segment, so handing out a colliding alias here
  // would mint a name that silently resolves somewhere else.
  const taken = new Set<string>([
    ...list.map((a) => a.alias.toLowerCase()),
    ...(activeProject()?.attachments ?? []).map((a) => a.alias.toLowerCase()),
  ]);
  const base = real.split("/").filter(Boolean).pop() ?? "item";
  const attachment: Attachment = {
    alias: dedupedAlias(base, taken),
    path: real,
    kind,
    note: trimmedNote,
    addedAt: Date.now(),
  };

  writeList(sessionId, [...list, attachment]);
  if (sessionId === currentId) mounts = [...list, attachment];
  return attachment;
}

export function detachFromConversation(sessionId: string, alias: string): void {
  const list = readList(sessionId).filter((a) => a.alias !== alias);
  writeList(sessionId, list);
  if (sessionId === currentId) mounts = list;
}

/* ----------------------------------------------------- per-turn resolution */

// The setMemorySession pattern: the turn sets the session, safePath reads
// the mounts. Loaded once per set rather than per path resolution -- a turn
// resolves many paths and the list only changes through the routes above,
// which refresh it when they touch the current session.
let currentId = "";
let mounts: Attachment[] = [];

export function setConversationSession(sessionId: string): void {
  currentId = sessionId;
  mounts = sessionId ? readList(sessionId) : [];
}

export function conversationMounts(): Attachment[] {
  return mounts;
}

export function findConversationMount(segment: string): Attachment | null {
  const lower = segment.toLowerCase();
  return mounts.find((a) => a.alias.toLowerCase() === lower) ?? null;
}
