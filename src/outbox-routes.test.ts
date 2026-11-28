import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The outbox over HTTP, through a real server: these routes are the only
 * way mail leaves, so what they refuse is the test. Sending is ON, so a
 * route that sends when it should not is caught by the stand-in for the
 * account's script, which records every send.
 */
const scratch = mkdtempSync(join(tmpdir(), "enio-outbox-routes-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
process.env.ENIO_EMAIL_SEND = "1";
process.env.ENIO_EMAIL_ALLOWED_TO = "@example.net";
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });

const acc = await import("./accounts.js");
acc.addScriptAccount({
  email: "enio@example.com",
  url: "https://script.google.com/enio@example.com/exec",
  secret: "s",
  version: 5,
  grants: ["mail.read", "mail.send"],
  owner: "agent",
});
const outbox = await import("./outbox.js");
const store = await import("./memory/store.js");
const { getDb, closeDb } = await import("./memory/db.js");
const { handle } = await import("./routes/outbox-routes.js");

const realFetch = globalThis.fetch;
const sent: Array<Record<string, string>> = [];
let bridgeAnswer: () => unknown = () => ({ ok: true });

let server: Server;
let base = "";
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!(await handle(req, res, url))) {
      res.writeHead(418);
      res.end("not owned");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  // The account's script is stood in for; the server under test is real.
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).startsWith(base)) return realFetch(url as string, init);
    if (!/script\.google\.com/.test(String(url))) throw new Error(`unexpected request to ${String(url)}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as { op: string; args: Record<string, string> };
    if (body.op === "mail.send") sent.push(body.args);
    return new Response(JSON.stringify(bridgeAnswer()), { status: 200 });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  server.close();
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

/** A draft written in a conversation, as the turn loop leaves it. */
function written(session: string, over: Partial<{ to: string; subject: string; body: string }> = {}) {
  const out = outbox.writeDraft({ to: "ana@example.net", subject: "Running late", body: "Ten minutes late.", ...over });
  assert.ok(out.ok, JSON.stringify(out));
  outbox.placeDraft(out.draft.id, session, { kind: "chat", key: "", request: "tell Ana I am late" });
  return outbox.getDraft(out.draft.id)!;
}
const thread = (session: string) =>
  (getDb().prepare(`SELECT role, content FROM messages WHERE session_id = ? ORDER BY id`).all(session) as Array<{ role: string; content: string }>);

describe("the outbox over HTTP", () => {
  test("there is no way to write a message here, only to act on one that was written", async () => {
    for (const [method, path] of [
      ["POST", "/outbox"],
      ["PUT", "/outbox"],
      ["POST", "/outbox/send"],
      ["DELETE", "/outbox"],
    ] as const) {
      const res = await call(method, path, { to: "ana@example.net", subject: "x", body: "y", revision: 1 });
      assert.equal(res.status, 418, `${method} ${path} must not be a route`);
    }
    assert.equal(outbox.listDrafts().length, 0);
    assert.equal(sent.length, 0);
  });

  test("what is waiting is listed, whole, with whether Send can work", async () => {
    const session = store.startSession();
    const draft = written(session);
    const list = await call("GET", "/outbox");
    assert.equal(list.status, 200);
    const mine = list.json.drafts.find((d: { id: string }) => d.id === draft.id);
    assert.deepEqual(
      { to: mine.to, subject: mine.subject, body: mine.body, status: mine.status, revision: mine.revision, edited: mine.edited, sendingOn: mine.sendingOn, sessionId: mine.sessionId },
      { to: ["ana@example.net"], subject: "Running late", body: "Ten minutes late.", status: "pending", revision: 1, edited: false, sendingOn: true, sessionId: session },
    );
    assert.match(mine.sender, /enio@example\.com/);
    assert.equal((await call("GET", `/outbox?session=${session}`)).json.drafts.length, 1);
    assert.equal((await call("GET", `/outbox/${draft.id}`)).json.draft.id, draft.id);
    assert.equal((await call("GET", "/outbox/00000000-0000-4000-8000-000000000000")).status, 404);
    outbox.discardDraft(draft.id);
    // Settled ones leave the default list and stay in the whole record.
    assert.equal((await call("GET", `/outbox?session=${session}`)).json.drafts.length, 0);
    assert.equal((await call("GET", `/outbox?all=1&session=${session}`)).json.drafts[0].status, "discarded");
  });

  test("a send names the revision that was read, and sends that text once", async () => {
    const session = store.startSession();
    const draft = written(session);
    const before = sent.length;

    // No revision: the window cannot say what its person was looking at.
    assert.equal((await call("POST", `/outbox/${draft.id}/send`, {})).status, 400);
    assert.equal((await call("POST", `/outbox/${draft.id}/send`, { revision: "1" })).status, 400);
    assert.equal((await call("POST", `/outbox/${draft.id}/send`, "not json")).status, 400);
    assert.equal(sent.length, before);

    // An edit made in another window moves the revision; the old one is
    // refused and nothing goes.
    const edit = await call("PUT", `/outbox/${draft.id}`, { revision: 1, body: "Twenty minutes late." });
    assert.equal(edit.status, 200);
    assert.deepEqual({ revision: edit.json.draft.revision, edited: edit.json.draft.edited }, { revision: 2, edited: true });
    const stale = await call("POST", `/outbox/${draft.id}/send`, { revision: 1 });
    assert.deepEqual({ status: stale.status, code: stale.json.error.code }, { status: 409, code: "changed" });
    assert.equal(stale.json.draft.revision, 2, "the refusal carries the draft as it stands");
    assert.equal(sent.length, before);

    const done = await call("POST", `/outbox/${draft.id}/send`, { revision: 2 });
    assert.equal(done.status, 200);
    assert.equal(done.json.draft.status, "sent");
    assert.deepEqual(sent.slice(before), [{ to: "ana@example.net", subject: "Running late", body: "Twenty minutes late." }]);
    // Said in the conversation, by the harness, in words built from the row.
    assert.equal(done.json.reply, 'You sent the message to ana@example.net: "Running late". It went as you changed it, not as I first wrote it.');
    assert.deepEqual(thread(session).at(-1), { role: "assistant", content: done.json.reply });

    // A second press does nothing.
    const again = await call("POST", `/outbox/${draft.id}/send`, { revision: 2 });
    assert.deepEqual({ status: again.status, code: again.json.error.code }, { status: 409, code: "not_waiting" });
    assert.equal(sent.length, before + 1);
    assert.equal(thread(session).filter((m) => m.content.startsWith("You sent")).length, 1);
  });

  test("an edit is checked like the message it replaces", async () => {
    const session = store.startSession();
    const draft = written(session);
    assert.equal((await call("PUT", `/outbox/${draft.id}`, { body: "x" })).status, 400, "an edit names its revision");
    const barred = await call("PUT", `/outbox/${draft.id}`, { revision: 1, to: "ana@example.net, stranger@elsewhere.example" });
    assert.equal(barred.status, 400);
    assert.match(barred.json.error.message, /stranger@elsewhere\.example is not in the allowed recipient list/);
    const notAddress = await call("PUT", `/outbox/${draft.id}`, { revision: 1, cc: "Ana" });
    assert.equal(notAddress.status, 400);
    // Nothing of a refused edit is kept.
    assert.deepEqual(
      (({ to, cc, revision }) => ({ to, cc, revision }))(outbox.getDraft(draft.id)!),
      { to: ["ana@example.net"], cc: [], revision: 1 },
    );
    // Fields that are not text are ignored, not stored as "[object Object]".
    const odd = await call("PUT", `/outbox/${draft.id}`, { revision: 1, subject: { a: 1 }, body: 7 });
    assert.equal(odd.status, 200);
    assert.deepEqual((({ subject, body }) => ({ subject, body }))(outbox.getDraft(draft.id)!), { subject: "Running late", body: "Ten minutes late." });
  });

  test("a send that fails leaves the message waiting and the thread quiet", async () => {
    const session = store.startSession();
    const draft = written(session);
    const before = thread(session).length;
    bridgeAnswer = () => ({ ok: false, error: "quota exceeded" });
    try {
      const failed = await call("POST", `/outbox/${draft.id}/send`, { revision: 1 });
      assert.deepEqual({ status: failed.status, code: failed.json.error.code }, { status: 502, code: "failed" });
      assert.match(failed.json.draft.lastError, /quota exceeded/);
      assert.equal(failed.json.draft.status, "pending");
      assert.equal(thread(session).length, before);
      // The revision moved with the failure, so the retry names the new one.
      assert.equal((await call("POST", `/outbox/${draft.id}/send`, { revision: 1 })).status, 409);
    } finally {
      bridgeAnswer = () => ({ ok: true });
    }
    const retry = await call("POST", `/outbox/${draft.id}/send`, { revision: outbox.getDraft(draft.id)!.revision });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.reply, 'You sent the message to ana@example.net: "Running late".');
  });

  test("discard settles it, says so in the thread, and nothing is sent", async () => {
    const session = store.startSession();
    const draft = written(session);
    const before = sent.length;
    const done = await call("POST", `/outbox/${draft.id}/discard`);
    assert.equal(done.status, 200);
    assert.equal(done.json.reply, 'You discarded the message to ana@example.net: "Running late". Nothing was sent.');
    assert.deepEqual(thread(session).at(-1), { role: "assistant", content: done.json.reply });
    assert.equal((await call("POST", `/outbox/${draft.id}/discard`)).status, 409);
    assert.equal((await call("POST", `/outbox/${draft.id}/send`, { revision: 1 })).status, 409);
    // Said as what it is: the message was settled, not "changed".
    const late = await call("PUT", `/outbox/${draft.id}`, { revision: 1, body: "x" });
    assert.deepEqual({ status: late.status, code: late.json.error.code }, { status: 409, code: "not_waiting" });
    assert.match(late.json.error.message, /already discarded/);
    assert.equal(sent.length, before);
  });

  test("a draft is found by the start of its id only when one waiting draft starts that way", async () => {
    const session = store.startSession();
    const a = written(session, { to: "ana@example.net" });
    const b = written(session, { to: "bea@example.net" });
    assert.equal(outbox.findDraft(a.id.slice(0, 8))?.id, a.id);
    assert.equal(outbox.findDraft(a.id)?.id, a.id);
    assert.equal(outbox.findDraft(a.id.slice(0, 3)), null, "too short to mean one message");
    assert.equal(outbox.findDraft(""), null);
    // Two that share a start: neither.
    getDb().prepare(`UPDATE outbox SET id = ? WHERE id = ?`).run(`${a.id.slice(0, 8)}${b.id.slice(8)}`, b.id);
    assert.equal(outbox.findDraft(a.id.slice(0, 8)), null);
    // A settled one is not found by its start.
    outbox.discardDraft(a.id);
    assert.equal(outbox.findDraft(a.id.slice(0, 8))?.id, `${a.id.slice(0, 8)}${b.id.slice(8)}`);
  });
});
