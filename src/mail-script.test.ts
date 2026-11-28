import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-mailscript-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
// Deliberately NO IMAP and NO SMTP: the account is the only backend, which
// is exactly the setup the walkthrough produces.
delete process.env.ENIO_IMAP_HOST;
delete process.env.ENIO_SMTP_HOST;
delete process.env.ENIO_EMAIL_SEND;
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });
mkdirSync(process.env.ENIO_WORKSPACE!, { recursive: true });

// The account exists BEFORE the tools module loads, because registration is
// decided at load time like every other config gate.
writeFileSync(
  join(process.env.ENIO_DATA_DIR, "accounts.json"),
  JSON.stringify({
    client: null,
    accounts: [
      {
        id: "acc1",
        provider: "appsscript",
        email: "enio@example.com",
        grants: ["mail.read", "mail.send"],
        addedAt: 1,
        scriptUrl: "https://script.google.com/macros/s/live/exec",
        scriptSecret: "s3cret",
      },
    ],
  }),
);

const { mailTools } = await import("./tools/mail.js");
const { emailTools } = await import("./tools/email.js");

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  rmSync(scratch, { recursive: true, force: true });
});

/** Answer as the deployed script would, recording what was asked. */
function stubScript(perOp: Record<string, unknown>) {
  const calls: Array<{ op: string; args: Record<string, unknown>; secret: string }> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ op: body.op, args: body.args ?? {}, secret: body.secret });
    return new Response(JSON.stringify({ ok: perOp[body.op] ?? null }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

/**
 * Mail through the connected account.
 *
 * The tools exist without a byte of IMAP or SMTP config -- the account IS
 * the backend -- and the credential is attached harness-side: the model
 * calls search_email and never holds a URL or secret. The read/act line and
 * the dry-run invariant both survive the new backend, which is the whole
 * point of testing it.
 */
describe("mail tools over a connected account", () => {
  test("registered with no IMAP or SMTP configured at all", () => {
    assert.equal(mailTools.length, 2, "search and read exist");
    assert.equal(emailTools.length, 1, "send exists");
  });

  test("search asks the script and prints ids a read can use", async () => {
    const calls = stubScript({
      "mail.recent": [
        { id: "18f2ab", from: "Ana <ana@x.com>", subject: "Draft ready", date: "2026-08-21T10:00:00Z", snippet: "It is done" },
      ],
    });
    const search = mailTools.find((t) => t.name === "search_email")!;
    const result = await search.run({ query: "draft", days: 7 });
    // The tool now also returns a notice naming the inbox; the text is what
    // the model reads.
    const out = typeof result === "string" ? result : result.text;
    assert.match(String((result as { notice?: string }).notice ?? ""), /enio@example\.com/, "the inbox read is announced");
    assert.match(out, /\[18f2ab\]/);
    assert.match(out, /open: https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/18f2ab/, "a link the model can quote");
    assert.match(out, /Draft ready/);
    assert.match(out, /enio@example\.com/);
    assert.equal(calls[0]!.op, "mail.recent");
    assert.match(String(calls[0]!.args.query), /draft/);
    assert.match(String(calls[0]!.args.query), /newer_than:7d/);
    assert.equal(calls[0]!.secret, "s3cret", "the harness attached the credential");
  });

  test("read fetches one message by the id search printed", async () => {
    stubScript({
      "mail.read": { id: "18f2ab", from: "Ana <ana@x.com>", to: "me", subject: "Draft ready", date: "2026-08-21T10:00:00Z", body: "It is done." },
    });
    const read = mailTools.find((t) => t.name === "read_email")!;
    const result = await read.run({ id: "18f2ab" });
    const out = typeof result === "string" ? result : result.text;
    assert.match(out, /Subject: Draft ready/);
    assert.match(out, /Open:    https:\/\/mail\.google\.com/);
    assert.match(out, /It is done\./);
  });

  test("send_email writes a message and sends nothing, whatever the backend", async () => {
    // The invariant predates accounts and outlived the dry run: an
    // irreversible act is not the model's to take. The tool writes to the
    // outbox; a person sends.
    const calls = stubScript({ "mail.send": { sent: true } });
    const send = emailTools.find((t) => t.name === "send_email")!;
    const result = await send.run({ to: "ana@x.com", subject: "hi", body: "there" });
    const out = typeof result === "string" ? result : result.text;
    assert.match(out, /^Written, not sent\./);
    assert.equal(calls.length, 0, "nothing left the machine");
    assert.match(out, /From: enio@example\.com/, "the message names the account it would go from");
  });

  test("with sending on, a person's Send goes through the account, and the tool still does not", async () => {
    const { config } = await import("./config.js");
    const outbox = await import("./outbox.js");
    const previous = config.emailSend;
    (config as { emailSend: boolean }).emailSend = true;
    try {
      const calls = stubScript({ "mail.send": { sent: true, to: "ana@x.com" } });
      const send = emailTools.find((t) => t.name === "send_email")!;
      const result = await send.run({ to: "ana@x.com", subject: "hi", body: "there" });
      assert.ok(typeof result !== "string");
      assert.match(result.text, /^Written, not sent\./);
      assert.equal(calls.length, 0, "the model's call sends nothing, with the switch on");
      const sent = await outbox.sendDraft((result.widget as { id: string }).id);
      assert.ok(sent.ok, JSON.stringify(sent));
      assert.match(sent.draft.result ?? "", /^Sent to ana@x\.com from enio@example\.com/);
      assert.equal(calls[0]!.op, "mail.send");
      assert.equal(calls.length, 1);
    } finally {
      (config as { emailSend: boolean }).emailSend = previous;
    }
  });
});
