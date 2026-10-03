import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-owner-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

const acc = await import("./accounts.js");
const store = await import("./memory/store.js");
const { closeDb } = await import("./memory/db.js");
after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

const script = (email: string, extra: Partial<Parameters<typeof acc.addScriptAccount>[0]> = {}) =>
  acc.addScriptAccount({
    email,
    url: `https://script.google.com/${email}/exec`,
    secret: "s",
    version: 5,
    grants: ["mail.read", "mail.send", "calendar.read"],
    ...extra,
  });

describe("whose account it is", () => {
  test("an account connected before the field existed is listed with no owner, and says so", () => {
    const legacy = script("enio@example.com");
    assert.equal(legacy.owner, undefined);
    assert.match(acc.describeAccount(legacy), /owner not set/);
    const marked = acc.setAccountOwner(legacy.id, "agent", "Enio's")!;
    assert.equal(marked.owner, "agent");
    assert.equal(acc.describeAccount(marked), "Enio's own account Enio's (enio@example.com)");
    assert.throws(() => acc.setAccountOwner(legacy.id, "robot" as never), /agent.*user/);
  });

  test("reading prefers the person's account, sending prefers the agent's", () => {
    const mine = script("mariz@example.com", { owner: "user", label: "personal" });
    assert.equal(acc.scriptMailAccount("read")!.email, "mariz@example.com", "my inbox is mine");
    assert.equal(acc.scriptMailAccount("send")!.email, "enio@example.com", "mail goes out as the agent");
    assert.equal(acc.scriptAccountWith("calendar.read")!.email, "mariz@example.com", "my calendar is mine");
    assert.match(acc.scriptMailAccount("read")!.described, /^your account personal/);
    // A machine default outranks owner preference; a conversation's choice outranks both.
    acc.setDefaultAccount(acc.listAccounts().find((a) => a.email === "enio@example.com")!.id);
    assert.equal(acc.scriptMailAccount("read")!.email, "enio@example.com");
    acc.setActiveAccount(mine.id);
    assert.equal(acc.scriptMailAccount("read")!.email, "mariz@example.com");
    acc.setActiveAccount(null);
    acc.setDefaultAccount(null);
    assert.equal(acc.scriptMailAccount("read")!.email, "mariz@example.com");
  });

  test("a grant the chosen account lacks falls through rather than failing", () => {
    const readOnly = script("ro@example.com", { owner: "user", label: "work", grants: ["mail.read"] });
    acc.setActiveAccount(readOnly.id);
    assert.equal(acc.scriptMailAccount("read")!.email, "ro@example.com");
    assert.equal(acc.scriptMailAccount("send")!.email, "enio@example.com", "work cannot send; the agent's own can");
    acc.setActiveAccount(null);
  });

  test("accounts are found by what a person calls them, and only when unambiguous", () => {
    assert.equal(acc.findAccountByName("work")!.email, "ro@example.com");
    assert.equal(acc.findAccountByName("enio's")!.email, "enio@example.com", "the owner word");
    assert.equal(acc.findAccountByName("mine")!.owner, "user");
    assert.equal(acc.findAccountByName("example.com"), null, "matches all three");
    assert.equal(acc.findAccountByName("nothing-like-this"), null);
  });

  test("'use my work email' is a switch request; a report of a search is not", () => {
    assert.equal(acc.accountSwitchRequest("use my work email"), "work");
    assert.equal(acc.accountSwitchRequest("switch to enio's account please"), "enio's");
    assert.equal(acc.accountSwitchRequest("Check my personal inbox for the invoice"), "personal");
    assert.equal(acc.accountSwitchRequest("what did Sam say about the invoice"), null);
    assert.equal(acc.accountSwitchRequest("yes"), null);
  });

  test("a conversation keeps its choice, and a removed account is forgotten", () => {
    const sid = store.startSession();
    assert.equal(acc.conversationAccount(sid), null);
    const work = acc.findAccountByName("work")!;
    acc.setConversationAccount(sid, work.id);
    assert.equal(acc.conversationAccount(sid), work.id);
    assert.throws(() => acc.setConversationAccount(sid, "0000000000000000"), /No such account/);
    acc.removeAccount(work.id);
    assert.equal(acc.conversationAccount(sid), null, "a deleted account is not a choice");
  });
});
