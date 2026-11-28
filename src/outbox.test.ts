import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sending is ON here, which is the point: with it on, the only thing that
// may reach a mail transport is sendDraft. Config reads the environment
// when it loads, so all of this comes before the first import.
const scratch = mkdtempSync(join(tmpdir(), "enio-outbox-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
process.env.ENIO_EMAIL_SEND = "1";
process.env.ENIO_EMAIL_ALLOWED_TO = "@example.net,boss@corp.example";
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });

const acc = await import("./accounts.js");
const enio = acc.addScriptAccount({
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
const emailModule = await import("./tools/email.js");
const { emailTools } = emailModule;
after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

const realFetch = globalThis.fetch;
/** Stand in for the connected account's script. Every send is recorded. */
function bridge(answer: (body: { op: string; args: Record<string, string> }) => unknown = () => ({ ok: true })) {
  const sent: Array<Record<string, string>> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (!/script\.google\.com/.test(String(url))) throw new Error(`unexpected request to ${String(url)}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as { op: string; args: Record<string, string> };
    if (body.op === "mail.send") sent.push(body.args);
    const out = answer(body);
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  return sent;
}
const write = (over: Partial<{ to: string; cc: string; subject: string; body: string }> = {}) => {
  const out = outbox.writeDraft({ to: "ana@example.net", subject: "Running late", body: "Ten minutes late.", ...over });
  assert.ok(out.ok, JSON.stringify(out));
  return out.draft;
};

describe("the outbox: Enio writes, a person sends", () => {
  test("no tool can reach a mail transport, with sending switched on", async () => {
    // The rule the rest stands on. The transport throws if anything touches
    // it, and send_email is called the way the model calls it.
    globalThis.fetch = (async () => {
      throw new Error("a tool reached the mail transport");
    }) as typeof fetch;
    try {
      const out = await emailTools[0]!.run({ to: "ana@example.net", subject: "Running late", body: "Ten minutes late." });
      assert.ok(typeof out !== "string");
      assert.match(out.text, /^Written, not sent\.\nSaved to .+\.eml\n\nFrom: enio@example\.com\nTo: ana@example\.net\nSubject: Running late\n\nTen minutes late\./);
      assert.equal(out.widget?.type, "mail");
      assert.match(out.final ?? "", /^I wrote this message\. It has not been sent\./);
      const draft = outbox.getDraft((out.widget as { id: string }).id)!;
      assert.equal(draft.status, "pending");
      assert.equal(draft.accountId, enio.id);
      assert.ok(draft.file && existsSync(draft.file), "the draft is a file a person can open");
      assert.match(readFileSync(draft.file!, "utf8"), /^From: enio@example\.com\nTo: ana@example\.net\nSubject: Running late\n\nTen minutes late\.\n$/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("what is written is checked: every address, the allow-list, one line of subject", () => {
    for (const [bad, why] of [
      [{ to: "Ana" }, /^"Ana" is not an email address\.$/],
      [{ to: "ana@example.net, stranger@elsewhere.com" }, /^Refused: stranger@elsewhere\.com is not in the allowed recipient list/],
      [{ cc: "stranger@elsewhere.com" }, /^Refused: stranger@elsewhere\.com is not/],
      [{ cc: "nobody" }, /^"nobody" in the cc is not an email address\.$/],
      [{ subject: "  " }, /^A message needs a subject\.$/],
    ] as const) {
      const out = outbox.writeDraft({ ...{ to: "ana@example.net", subject: "s", body: "b" }, ...bad });
      assert.ok(!out.ok && why.test(out.reason), JSON.stringify(out));
    }
    const draft = write({ to: '"Costa, Ana" <Ana@Example.net>; boss@corp.example', cc: "tom@example.net", subject: "Hello\r\nBcc: x@elsewhere.com" });
    assert.deepEqual(draft.to, ["ana@example.net", "boss@corp.example"]);
    assert.deepEqual(draft.cc, ["tom@example.net"]);
    assert.equal(draft.subject, "Hello Bcc: x@elsewhere.com");
    assert.deepEqual(draft.proposed, { to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body });
  });

  test("a new draft replaces a waiting one from the same place to the same people, and no other", () => {
    const sid = store.startSession();
    const place = (id: string, key = "", kind: "chat" | "automation" = "chat", session = sid) => outbox.placeDraft(id, session, { kind, key, request: "send ana a note" });
    const first = write();
    assert.deepEqual(place(first.id), { replaced: null });
    assert.deepEqual(outbox.getDraft(first.id)!.origin, { kind: "chat", key: "", request: "send ana a note" });
    assert.equal(outbox.getDraft(first.id)!.sessionId, sid);
    // "make it shorter": the same conversation, the same person.
    const shorter = write({ body: "Late." });
    assert.deepEqual(place(shorter.id), { replaced: first.id });
    assert.equal(outbox.getDraft(first.id)!.status, "replaced");
    assert.equal(outbox.getDraft(shorter.id)!.status, "pending");
    // To someone else: a second message, not a revision.
    const other = write({ to: "tom@example.net" });
    assert.deepEqual(place(other.id), { replaced: null });
    // Another conversation.
    const elsewhere = write();
    assert.deepEqual(place(elsewhere.id, "", "chat", store.startSession()), { replaced: null });
    // Two steps of one automation run share a session and both write to
    // Ana: two messages. The same step writing again replaces its own.
    const run = store.startSession();
    const stepOne = write();
    const stepTwo = write();
    assert.deepEqual(place(stepOne.id, "n1", "automation", run), { replaced: null });
    assert.deepEqual(place(stepTwo.id, "n2", "automation", run), { replaced: null });
    const again = write();
    assert.deepEqual(place(again.id, "n1", "automation", run), { replaced: stepOne.id });
    assert.deepEqual(outbox.listDrafts({ status: "pending", sessionId: run }).map((d) => d.id).sort(), [stepTwo.id, again.id].sort());
    // A waiting draft is never replaced by one that was sent or dropped.
    assert.equal(outbox.getDraft(shorter.id)!.status, "pending");
  });

  test("a person's edit is written to the row that will be sent, and a stale card cannot overwrite it", () => {
    const draft = write();
    assert.equal(outbox.wasEdited(draft), false);
    const edited = outbox.updateDraft(draft.id, 1, { body: "Fifteen minutes late.", to: "ana@example.net, boss@corp.example" });
    assert.ok(edited.ok);
    assert.equal(edited.draft.revision, 2);
    assert.equal(edited.draft.body, "Fifteen minutes late.");
    assert.deepEqual(edited.draft.to, ["ana@example.net", "boss@corp.example"]);
    assert.equal(outbox.wasEdited(edited.draft), true);
    assert.equal(edited.draft.proposed.body, "Ten minutes late.", "what Enio wrote is kept as written");
    // A card that was opened before the edit.
    const stale = outbox.updateDraft(draft.id, 1, { body: "Overwritten." });
    assert.ok(!stale.ok && stale.code === "changed");
    // An edit is checked like a write: a hand-typed stranger is refused.
    const barred = outbox.updateDraft(draft.id, 2, { to: "stranger@elsewhere.com" });
    assert.ok(!barred.ok && barred.code === "invalid" && /not in the allowed recipient list/.test(barred.message));
    assert.equal(outbox.getDraft(draft.id)!.body, "Fifteen minutes late.");
    assert.ok(!outbox.updateDraft("no-such-id", 1, {}).ok);
  });

  test("sending: the stored text goes, once", async () => {
    const draft = write({ cc: "tom@example.net" });
    outbox.updateDraft(draft.id, 1, { body: "Fifteen minutes late." });
    const sent = bridge();
    try {
      // A card opened before the edit cannot send what it showed.
      const stale = await outbox.sendDraft(draft.id, 1);
      assert.ok(!stale.ok && stale.code === "changed");
      assert.equal(sent.length, 0);
      // Two Sends at once: one message.
      const [a, b] = await Promise.all([outbox.sendDraft(draft.id, 2), outbox.sendDraft(draft.id, 2)]);
      assert.equal([a, b].filter((r) => r.ok).length, 1);
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0], { to: "ana@example.net", subject: "Running late", body: "Fifteen minutes late.\n\n(cc requested: tom@example.net)" });
      const after = outbox.getDraft(draft.id)!;
      assert.equal(after.status, "sent");
      // The bridge has no cc, and the outcome says who was not reached.
      assert.match(after.result ?? "", /^Sent to ana@example\.net from enio@example\.com\. The cc \(tom@example\.net\) was NOT sent to/);
      // And never twice.
      const again = await outbox.sendDraft(draft.id);
      assert.ok(!again.ok && again.code === "not_waiting" && /already sent/.test(again.message));
      assert.equal(sent.length, 1);
      assert.ok(!outbox.updateDraft(draft.id, after.revision, { body: "x" }).ok, "a sent message is not edited");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a send that fails leaves the message waiting, with the edits in it and the reason on it", async () => {
    const draft = write();
    outbox.updateDraft(draft.id, 1, { body: "Edited by hand." });
    // The script refuses.
    let sent = bridge(() => ({ error: "Service invoked too many times for one day: email." }));
    try {
      const refused = await outbox.sendDraft(draft.id);
      assert.ok(!refused.ok && refused.code === "failed");
      assert.match(refused.message, /^Could not send: Service invoked too many times/);
      assert.doesNotMatch(refused.message, /may or may not have gone/, "a refusal is a refusal");
      let now = outbox.getDraft(draft.id)!;
      assert.equal(now.status, "pending");
      assert.equal(now.body, "Edited by hand.");
      assert.equal(now.lastError, refused.message);
      assert.equal(now.revision, 3, "the card is made to look again");
      // The request never came back: it may have gone.
      sent = bridge(() => new Error("socket hang up"));
      const lost = await outbox.sendDraft(draft.id);
      assert.ok(!lost.ok && /may or may not have gone: check the Sent folder/.test(lost.message));
      assert.equal(outbox.getDraft(draft.id)!.status, "pending");
      // And then it works.
      sent = bridge();
      now = outbox.getDraft(draft.id)!;
      const ok = await outbox.sendDraft(draft.id, now.revision);
      assert.ok(ok.ok);
      assert.equal(sent.length, 1);
      assert.equal(outbox.getDraft(draft.id)!.lastError, null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("what was true when it was written is asked again when it is sent", async () => {
    const sent = bridge();
    try {
      // The account lost its send grant, or is gone, while the message waited.
      const draft = write();
      const readOnly = acc.addScriptAccount({ email: "enio@example.com", url: "https://script.google.com/enio@example.com/exec", secret: "s", version: 5, grants: ["mail.read"], owner: "agent" });
      const gone = await outbox.sendDraft(draft.id);
      assert.ok(!gone.ok && gone.code === "invalid" && /no longer connected, or can no longer send/.test(gone.message), JSON.stringify(gone));
      assert.equal(outbox.getDraft(draft.id)!.status, "pending");
      assert.equal(sent.length, 0);
      acc.removeAccount(readOnly.id);
      acc.addScriptAccount({ email: "enio@example.com", url: "https://script.google.com/enio@example.com/exec", secret: "s", version: 5, grants: ["mail.read", "mail.send"], owner: "agent" });
      // An address that got into the row some other way is still checked.
      const direct = write();
      getDb().prepare(`UPDATE outbox SET to_addrs = ? WHERE id = ?`).run(JSON.stringify(["stranger@elsewhere.com"]), direct.id);
      const barred = await outbox.sendDraft(direct.id);
      assert.ok(!barred.ok && barred.code === "invalid" && /not in the allowed recipient list/.test(barred.message));
      assert.equal(sent.length, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("discarding, and a send that never came back", async () => {
    const draft = write();
    const dropped = outbox.discardDraft(draft.id);
    assert.ok(dropped.ok && dropped.draft.status === "discarded");
    assert.ok(!outbox.discardDraft(draft.id).ok);
    const sent = bridge();
    try {
      assert.ok(!(await outbox.sendDraft(draft.id)).ok, "a discarded message is not sent");
      assert.equal(sent.length, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
    // A process that died in the middle of a send leaves the row "sending".
    // Released by age, so that another process starting up does not call a
    // send in progress lost.
    const hung = write();
    const recent = write();
    getDb().prepare(`UPDATE outbox SET status = 'sending', decided_at = ? WHERE id = ?`).run(Date.now() - 10 * 60_000, hung.id);
    getDb().prepare(`UPDATE outbox SET status = 'sending', decided_at = ? WHERE id = ?`).run(Date.now() - 5_000, recent.id);
    outbox.listDrafts();
    const back = outbox.getDraft(hung.id)!;
    assert.equal(back.status, "pending");
    assert.match(back.lastError ?? "", /started and never finished\. It may or may not have gone/);
    assert.equal(outbox.getDraft(recent.id)!.status, "sending", "one in progress is left alone");
  });

  test("a send that outlives its claim does not write over what the row has become", async () => {
    // A send still open when the row was released as stale (a process
    // presumed dead that was only slow). Whatever happens to the row
    // next -- edited, discarded, sent again -- the first send's late
    // answer is not written onto it.
    const slow = (finish: { resolve: (v: unknown) => void; reject: (e: Error) => void }[]) => {
      const sent: string[] = [];
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { op: string; args: { body: string } };
        if (body.op !== "mail.send") return new Response(JSON.stringify({ ok: [] }), { status: 200 });
        sent.push(body.args.body);
        return new Promise((resolve, reject) => finish.push({ resolve: () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })), reject }));
      }) as typeof fetch;
      return sent;
    };
    const age = (id: string) => getDb().prepare(`UPDATE outbox SET decided_at = decided_at - ? WHERE id = ?`).run(6 * 60_000, id);
    try {
      // Edited after the release, then the first send succeeds.
      const pending: { resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
      const sent = slow(pending);
      const draft = write({ body: "We accept the offer." });
      const first = outbox.sendDraft(draft.id);
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(outbox.getDraft(draft.id)!.status, "sending");
      age(draft.id);
      outbox.listDrafts(); // releases it
      const released = outbox.getDraft(draft.id)!;
      assert.equal(released.status, "pending");
      assert.ok(outbox.updateDraft(draft.id, released.revision, { body: "We decline the offer." }).ok);
      pending[0]!.resolve(null);
      const late = await first;
      assert.ok(!late.ok && late.code === "changed", JSON.stringify(late));
      assert.match(late.message, /^Sent to ana@example\.net from enio@example\.com\. Its record was released while it was going/);
      const now = outbox.getDraft(draft.id)!;
      assert.deepEqual({ status: now.status, body: now.body }, { status: "pending", body: "We decline the offer." }, "not marked sent with text that never went");
      assert.deepEqual(sent, ["We accept the offer."]);

      // Discarded after the release, then the first send fails.
      const pending2: typeof pending = [];
      slow(pending2);
      const other = write();
      const firstOther = outbox.sendDraft(other.id);
      await new Promise((r) => setTimeout(r, 5));
      age(other.id);
      outbox.listDrafts();
      assert.ok(outbox.discardDraft(other.id).ok);
      pending2[0]!.reject(new Error("socket hang up"));
      assert.ok(!(await firstOther).ok);
      assert.equal(outbox.getDraft(other.id)!.status, "discarded", "a discarded message does not come back");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("what a Cc means on a connected account is said before the send", () => {
    const { writtenReply } = emailModule;
    const plain = write();
    assert.equal(outbox.ccNote(plain), "");
    assert.equal(outbox.draftView(plain).ccNote, "");
    assert.doesNotMatch(writtenReply(plain, false), /cannot cc/);
    const withCc = write({ cc: "tom@example.net" });
    const note = "This account cannot cc: tom@example.net will not receive it. A line naming that address is added at the end of the message when it is sent. To reach them, put them in To.";
    assert.equal(outbox.ccNote(withCc), note);
    assert.equal(outbox.draftView(withCc).ccNote, note);
    assert.ok(writtenReply(withCc, false).includes(note));
    // SMTP sends a Cc as a Cc: nothing to say.
    assert.equal(outbox.ccNote({ accountId: null, cc: ["tom@example.net"] }), "");
    // A run with no conversation behind it has no card: the reply says where the message is.
    assert.match(writtenReply(plain, false, true), /It is waiting in the outbox for you to send\. In a terminal, `enio outbox` lists it\.$/);
    assert.match(writtenReply(plain, false), /It is waiting for you: send it, change it, or discard it\.$/);
  });
});
