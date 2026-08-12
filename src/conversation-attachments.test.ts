import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "enio-conv-attach-"));
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-such-mcp.json");
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

// A folder OUTSIDE every configured root — the entire point of an attachment.
const outside = join(scratch, "elsewhere");
mkdirSync(join(outside, "nested"), { recursive: true });
writeFileSync(join(outside, "notes.txt"), "hello from outside\n");
writeFileSync(join(outside, "nested", "deep.txt"), "deeper\n");

const conv = await import("./conversation-attachments.js");
const { startSession } = await import("./memory/store.js");
const { safePath } = await import("./tools/fs.js");
const { closeDb } = await import("./memory/db.js");

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

test("attach, list, detach round-trip persists on the session row", () => {
  const id = startSession();
  const a = conv.attachToConversation(id, outside, "reference docs");
  assert.equal(a.alias, "elsewhere");
  assert.equal(a.kind, "folder");
  assert.equal(a.note, "reference docs");

  const listed = conv.listConversationAttachments(id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.path, a.path);

  conv.detachFromConversation(id, "elsewhere");
  assert.equal(conv.listConversationAttachments(id).length, 0);
});

test("the note cap refuses, never truncates", () => {
  const id = startSession();
  assert.throws(() => conv.attachToConversation(id, outside, "x".repeat(121)), /cap/i);
  assert.equal(conv.listConversationAttachments(id).length, 0, "nothing was stored");
});

test("unattachable roots are refused: /, $HOME, the data dir, the workspace", () => {
  const id = startSession();
  for (const bad of ["/", homedir(), process.env.ENIO_DATA_DIR!, process.env.ENIO_WORKSPACE!]) {
    assert.throws(() => conv.attachToConversation(id, bad), Error, `should refuse ${bad}`);
  }
});

test("duplicates refuse; aliases dedupe against reserved names and each other", () => {
  const id = startSession();
  conv.attachToConversation(id, outside);
  assert.throws(() => conv.attachToConversation(id, outside), /Already attached/);

  // A different folder with a reserved basename cannot claim the alias.
  const outDir = join(scratch, "out");
  mkdirSync(outDir, { recursive: true });
  const reserved = conv.attachToConversation(id, outDir);
  assert.notEqual(reserved.alias.toLowerCase(), "out");
});

test("safePath resolves conversation mounts and refuses escapes", () => {
  const id = startSession();
  conv.setConversationSession(id);
  // assertAttachable realpaths the mount (macOS: /var → /private/var), so
  // resolution is asserted against the stored path, not the raw input.
  const root = conv.attachToConversation(id, outside).path;

  // Alias-prefixed paths resolve inside the mount.
  assert.equal(safePath("elsewhere/notes.txt"), join(root, "notes.txt"));
  assert.equal(safePath("elsewhere/nested/deep.txt"), join(root, "nested", "deep.txt"));

  // Traversal cannot leave it.
  assert.throws(() => safePath("elsewhere/../../etc/passwd"), /escapes/i);

  // Plain paths still confine to the workspace, and the error now teaches
  // the alias grammar.
  assert.throws(() => safePath("../outside-everything"), /elsewhere/);

  // Another conversation's mounts are not this one's: the same path now
  // resolves as an ordinary workspace-relative path, nowhere near the
  // attached folder.
  conv.setConversationSession(startSession());
  assert.equal(
    safePath("elsewhere/notes.txt"),
    join(process.env.ENIO_WORKSPACE!, "elsewhere", "notes.txt"),
  );
});

test("a corrupt attachments column degrades to none, never a failed turn", async () => {
  const { getDb } = await import("./memory/db.js");
  const id = startSession();
  getDb().prepare(`UPDATE sessions SET attachments = 'not json' WHERE id = ?`).run(id);
  assert.deepEqual(conv.listConversationAttachments(id), []);
  conv.setConversationSession(id);
  assert.deepEqual(conv.conversationMounts(), []);
});

test("attaching to a conversation that does not exist is an error", () => {
  assert.throws(() => conv.attachToConversation("no-such-session", outside), /No conversation/);
});

test("the prompt overlay names the mounts; mentions list their files", async () => {
  const id = startSession();
  conv.setConversationSession(id);
  conv.attachToConversation(id, outside, "the source material");

  const { workspaceFiles } = await import("./mentions.js");
  const files = workspaceFiles();
  assert.ok(files.includes("elsewhere/notes.txt"), `missing from ${files.join(", ")}`);
  assert.ok(files.includes("elsewhere/nested/deep.txt"));

  // The overlay is not exported from agent.ts; the mounts it renders are.
  // Assert the source of truth it reads.
  const mounts = conv.conversationMounts();
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0]!.note, "the source material");

  conv.setConversationSession("");
  assert.deepEqual(conv.conversationMounts(), []);
});
