import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before } from "node:test";

// Both the workspace and the data directory are redirected before anything
// imports config, so this never reads or deletes the developer's own files --
// which is exactly what a test about deleting files must not do.
const scratch = mkdtempSync(join(tmpdir(), "enio-files-"));
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_DATA_DIR = join(scratch, "data");
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

const WORK = process.env.ENIO_WORKSPACE;
const CONV = "11111111-2222-3333-4444-555555555555";

let files: typeof import("./files.js");

before(async () => {
  files = await import("./files.js");
});

function seed() {
  mkdirSync(join(WORK, "attachments", CONV), { recursive: true });
  mkdirSync(join(WORK, "notes"), { recursive: true });
  writeFileSync(join(WORK, "attachments", CONV, "shot.png"), "x".repeat(100));
  writeFileSync(join(WORK, "attachments", CONV, "scan.pdf"), "y".repeat(50));
  writeFileSync(join(WORK, "budget.csv"), "z".repeat(10));
  writeFileSync(join(WORK, "notes", "plan.md"), "w".repeat(5));
}

test("attachments are grouped by conversation and kept out of the workspace list", () => {
  seed();
  const storage = files.listStorage();

  assert.deepEqual(
    storage.workspace.map((f) => f.path).sort(),
    ["budget.csv", "notes/plan.md"],
    "workspace listing must not include attachments",
  );

  const conv = storage.conversations.find((c) => c.id === CONV);
  assert.ok(conv, "the conversation's attachments should be grouped under its id");
  assert.deepEqual(conv.files.map((f) => f.name).sort(), ["scan.pdf", "shot.png"]);
  assert.equal(conv.bytes, 150);
  // No session row exists for this id, so it reads as discarded -- which is
  // the case the dialog has to render rather than hide.
  assert.equal(conv.title, null);
  assert.equal(storage.totalBytes, 165);
});

test("an attachment path is the mention that resolves to it", () => {
  const [path] = files.attachmentPaths();
  assert.ok(path?.startsWith(`${files.ATTACH_DIR}/${CONV}/`), `unexpected path ${path}`);
});

/**
 * The workspace is where the user's own work lives, so a delete reachable from
 * an HTTP query string has to be narrow in three directions: it cannot leave
 * the workspace, it cannot take a whole tree with it, and it cannot touch
 * anything that is not an attachment copy at all.
 */
test("deleting refuses to escape the workspace", () => {
  for (const path of ["../secrets.txt", "/etc/passwd", "../../"]) {
    assert.throws(() => files.removeFile(path), /escapes the workspace|attachment/);
  }
  assert.ok(existsSync(join(WORK, "budget.csv")), "nothing should have been removed");
});

test("deleting refuses the user's own workspace files entirely", () => {
  // An attachment is enio's copy — deleting it never touches the original.
  // Everything else in the workspace is the user's actual work, and the only
  // path that removes it is the user doing so themselves, in Finder.
  assert.throws(() => files.removeFile("budget.csv"), files.FileRefused);
  assert.throws(() => files.removeFile("notes/plan.md"), files.FileRefused);
  assert.ok(existsSync(join(WORK, "budget.csv")));
  assert.ok(existsSync(join(WORK, "notes", "plan.md")));
});

test("deleting refuses a directory that is not a conversation's attachments", () => {
  assert.throws(() => files.removeFile("notes"), files.FileRefused);
  assert.throws(() => files.removeFile("attachments"), files.FileRefused);
  assert.throws(() => files.removeFile("."), files.FileRefused);
  assert.ok(existsSync(join(WORK, "notes", "plan.md")));
});

test("deleting one file leaves the rest of the conversation alone", () => {
  assert.equal(files.removeFile(`attachments/${CONV}/scan.pdf`), 50);
  assert.ok(!existsSync(join(WORK, "attachments", CONV, "scan.pdf")));
  assert.ok(existsSync(join(WORK, "attachments", CONV, "shot.png")));
});

test("discarding a conversation takes its whole folder, and reports the bytes", () => {
  assert.equal(files.removeConversationFiles(CONV), 100);
  assert.ok(!existsSync(join(WORK, "attachments", CONV)));
  assert.equal(files.listStorage().conversations.length, 0);
  // A conversation that never attached anything is not an error to clean up.
  assert.equal(files.removeConversationFiles("99999999-0000-0000-0000-000000000000"), 0);
});
