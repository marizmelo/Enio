import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/** The share of real requests the possessive rule must find. "tuned" are
 *  the three sets it was written against (78 of 99 and 68 of 89 found);
 *  "unseen" was written after it was frozen (20 of 30 and 17 of 28). The
 *  floors sit a little under what was measured, so a change that loses
 *  phrases fails. Lower one only with the phrases that justify it.
 *
 *  The unseen set is held out for RECALL only. The frozen rule read one of
 *  its 49 traps as Enio's ("How often do you look at your inbox when I'm
 *  not asking?") and was changed for it, so "no trap is read as Enio's"
 *  below is a regression check on every set, not held-out evidence. */
const FLOOR = { tuned: 0.7, unseen: 0.55 } as const;
/** Traps read as the person's own. Each has a label later in the sentence
 *  or a mailbox that is not a Google one. Reading as theirs changes
 *  nothing unless the conversation was on Enio's account. */
const LIVED_WITH: string[] = [
  "check my inbox no wait the work one",
  "did the mail carrier leave anything in my mailbox today",
];

const realFetch = globalThis.fetch;
/**
 * Stand in for the Apps Script bridge and, when replies are given, for the
 * model. Every request is recorded; `system()` is the first system prompt
 * the model was sent.
 */
function stubScript(
  rows: Array<Record<string, string>> = [],
  model: Array<{ content?: string; tool?: { name: string; args: unknown } }> = [],
) {
  const calls = Object.assign([] as Array<{ url: string }>, { system: () => systemPrompt });
  let systemPrompt = "";
  const queue = [...model];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const address = String(url);
    if (/script\.google\.com/.test(address)) {
      calls.push({ url: address });
      const op = JSON.parse(String(init?.body ?? "{}")).op;
      return new Response(JSON.stringify({ ok: op === "mail.read" ? { from: "a", subject: "s", body: "b" } : rows }), { status: 200 });
    }
    // The embedding model is not on a test machine; refused, recall falls
    // back to keywords.
    if (/huggingface/.test(address)) throw new Error("no network in tests");
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: unknown }> };
    const first = body.messages?.find((m) => m.role === "system");
    if (first && !systemPrompt) systemPrompt = String(first.content);
    const next = queue.shift() ?? { content: "(done)" };
    const delta = next.tool
      ? { tool_calls: [{ index: 0, id: "call_1", function: { name: next.tool.name, arguments: JSON.stringify(next.tool.args) } }] }
      : { content: next.content };
    return new Response(
      new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return calls;
}

describe("whose account it is", () => {
  test("an account connected before the field existed is listed with no owner, and says so", () => {
    assert.match(acc.nothingOfYoursNotice() ?? "", /No account is connected.*enio:\/\/panel\/accounts\/add/, "nothing connected: the notice points at Connections");
    const legacy = script("enio@example.com");
    assert.equal(acc.nothingOfYoursNotice(), null, "an account with no owner may be the person's");
    assert.equal(legacy.owner, undefined);
    assert.match(acc.describeAccount(legacy), /owner not set/);
    const marked = acc.setAccountOwner(legacy.id, "agent", "Enio's")!;
    assert.equal(marked.owner, "agent");
    assert.equal(acc.describeAccount(marked), "Enio's own account Enio's (enio@example.com)");
    assert.throws(() => acc.setAccountOwner(legacy.id, "robot" as never), /agent.*user/);
  });

  test("with only the agent's account, reading 'my mail' finds nothing of yours and says which account exists", async () => {
    assert.equal(acc.scriptMailAccount("read"), null, "Enio's own is never the fallback for reading");
    assert.match(acc.nothingOfYoursNotice() ?? "", /only Enio's own.*\[Connections\]\(enio:\/\/panel\/accounts\/add\)/);
    assert.equal(acc.anyMailReadAccount(), true, "but the tools exist — the answer is a sentence, not a missing tool");
    const { mailTools } = await import("./tools/mail.js");
    const search = mailTools.find((t) => t.name === "search_email")!;
    for (const args of [{}, { account: "user's" }, { account: "my" }]) {
      const r = await search.run(args);
      const text = typeof r === "string" ? r : r.text;
      assert.match(text, /No account of yours is connected/, JSON.stringify(args));
      assert.match(text, /my own account/, "the agent speaks of its own account in the first person");
    }
    const read = mailTools.find((t) => t.name === "read_email")!;
    const rr = await read.run({ id: "abc" });
    assert.match(typeof rr === "string" ? rr : rr.text, /No account of yours is connected/);
    assert.equal(acc.agentOnlyMailAccount()!.email, "enio@example.com");
    assert.equal(acc.scriptMailAccount("send")!.email, "enio@example.com", "sending as the agent is the default");
    // Chosen on purpose, it reads.
    acc.setActiveAccount(acc.listAccounts()[0]!.id);
    assert.equal(acc.scriptMailAccount("read")!.email, "enio@example.com");
    acc.setActiveAccount(null);
  });

  test("reading prefers the person's account, sending prefers the agent's", () => {
    const mine = script("mariz@example.com", { owner: "user", label: "personal" });
    assert.equal(acc.nothingOfYoursNotice(), null, "with an account of the person's there is nothing to say");
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
    assert.equal(acc.accountSwitchRequest("check my email"), null, "a request, not a switch");
    assert.equal(acc.accountSwitchRequest("read the inbox"), null);
    assert.equal(acc.ownerWord("user's"), "user");
    assert.equal(acc.ownerWord("enio's"), "agent");
    assert.equal(acc.ownerWord("work"), null);
    assert.equal(acc.accountSwitchRequest("yes"), null);
  });

  test("the possessive is read from the person's words: the phrases it is held to", () => {
    // Written by models playing users, who never saw the rule, and
    // labelled a second time, blind; only the phrases both readers were
    // sure of are kept. Two things are asserted and they are not equal. A
    // trap read as Enio's sends one turn's read to the wrong mailbox, so
    // there may be none. A request that is missed costs what it cost
    // before this existed, so that is a floor to stay above, not a count
    // to hit.
    const rows = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "scripts", "whose-account-data.json"), "utf8"),
    ) as Array<{ text: string; label: "user" | "agent" | "none"; set: "tuned" | "unseen" }>;
    assert.ok(rows.length > 150, "the fixture is the real one");
    const got = rows.map((r) => ({ ...r, got: acc.ownerAsked(r.text) ?? "none" }));
    // Nothing is ever read as Enio's that was not: that is the move that
    // puts a conversation on the wrong account.
    const wrongAgent = got.filter((r) => r.got === "agent" && r.label !== "agent");
    assert.deepEqual(wrongAgent.map((r) => `${r.label} read as Enio's: ${r.text}`), []);
    // And no request for Enio's is read as theirs.
    const swapped = got.filter((r) => r.got === "user" && r.label === "agent");
    assert.deepEqual(swapped.map((r) => r.text), []);
    // A trap read as theirs moves nothing unless the conversation was on
    // Enio's account, so a few are lived with -- named, so that one more is
    // a decision.
    const wrongUser = got.filter((r) => r.got === "user" && r.label === "none").map((r) => r.text);
    assert.deepEqual(wrongUser.sort(), [...LIVED_WITH].sort());
    for (const set of ["tuned", "unseen"] as const) {
      for (const owner of ["user", "agent"] as const) {
        const asked = got.filter((r) => r.set === set && r.label === owner);
        const found = asked.filter((r) => r.got === owner).length;
        assert.ok(asked.length > 10, `${set} ${owner}: the set is there`);
        assert.ok(
          found / asked.length >= FLOOR[set],
          `${set} ${owner}: ${found} of ${asked.length} found, below ${FLOOR[set]}`,
        );
      }
    }
  });

  test("my is the person's and your is Enio's, on the mailbox itself and nowhere else", () => {
    for (const [text, owner] of [
      ["check your email", "agent"],
      ["check my email", "user"],
      ["what’s on my calendar tomorrow", "user"],
      ["look in Enio’s inbox for the receipt", "agent"],
      ["use my own account", "user"],
      ["ok now check yours", "agent"],
      ["go back to mine", "user"],
      // One phrase for each shape the fixture alone would not miss.
      ["has anything landed in your inbox?", "agent"],
      ["look in my account for the flight confirmation", "user"],
      ["does my calendar have anything that day", "user"],
      ["what about Enio's calendar", "agent"],
      ["your inbox", "agent"],
      ["what about in mine", "user"],
      ["did anyone write to you today?", "agent"],
      ["do I have any new emails", "user"],
      // The one told off is not the request.
      ["not mine, yours. check your inbox again", "agent"],
      ["don't look in your inbox, look in mine", "user"],
      ["It wasn't in your inbox. Is it in my inbox?", "user"],
      ["don't forget to check your inbox", "agent"],
      ["check your inbox pls", "agent"],
      // Both owners named: two requests, or a correction. One turn has one
      // account to read from, so nothing is chosen.
      ["check my inbox, then check your inbox", null],
      ["why are you looking in your inbox, I meant mine", null],
      ["that was in your inbox, I wanted mine", null],
      // A cut may silence a reading and never choose one: here the part
      // set aside as reported speech holds the correction.
      ["check your inbox. Actually Ana said it's in mine, so check my inbox", null],
      ["check your inbox: sorry, I meant my inbox", null],
      ["check your inbox: no wait, check my calendar", null],
      ["there's a typo in your mail", null],
      ["Hey, email Bob, please check your calendar", null],
      // An address, a destination, one message, a capability, a quotation.
      ["what's your email address?", null],
      ["your email?", null],
      ["send it to my email", null],
      ["Did you get my email with the photos attached?", null],
      ["Your email to the landlord was too long, cut it in half", null],
      ["there's a typo in your email", null],
      ["Can you read my email or only your own?", null],
      ["does your calendar support recurring events?", null],
      ["How can you check your email from another computer?", null],
      ["How often do you look at your inbox when I'm not asking?", null],
      ["Write back saying I'll check my calendar and let her know by Friday", null],
      ['Ana wrote "check your inbox, I sent the contract" - what should I say back?', null],
      // Somebody else's "your": the recipient of a message Enio is to
      // write, or the person themself in what a site told them.
      ["Email Bob, please check your calendar for Tuesday", null],
      ["email my boss please check your calendar", null],
      ["Ana replied that it's in your inbox", null],
      // And the shapes those cuts must not swallow.
      ["what does my calendar say for tomorrow?", "user"],
      ["who wrote to you today?", "agent"],
      ["Reply to Sam: it's on your calendar for Friday", null],
      ["Google says it sent a code, check your email", null],
      ["the website says the confirmation link is in your inbox", null],
      ["summarize this: Please check your inbox for the confirmation link", null],
      // Conversation, not a mailbox.
      ["My weekend was great. How about yours?", null],
      ["who wrote you?", null],
      // A label picks the account, not the possessive.
      ["check my work email", null],
    ] as const) {
      assert.equal(acc.ownerAsked(text), owner, text);
    }
  });

  test("a message long enough to hold someone else's words is left alone", () => {
    // Pasted mail has no quotation marks around it, and its author's
    // "check your inbox" is not the person asking.
    const pasted =
      "Can you summarise this for me?\n\n" +
      "Hi all, the receipts went out this morning. Please check your inbox for yours and reply by Friday. ".repeat(5);
    assert.ok(pasted.length > 400);
    assert.equal(acc.ownerAsked(pasted), null);
    assert.equal(acc.ownerAsked("Please check your inbox for yours and reply by Friday."), "agent", "the same words, said by the person");
    // Short, and broken over lines: the second line is the paste.
    assert.equal(acc.ownerAsked("summarize this email\nHi team, please check your inbox for the invoice"), null);
  });

  test("a name is taken as written, and a phrase that is none says nothing", () => {
    // The switch by name is STORED and sends follow it, so the name is not
    // tidied: stripping "function words" stored "work" for an account
    // labelled "old work".
    assert.equal(acc.accountSwitchRequest("use my old work account"), "old work");
    assert.equal(acc.accountSwitchRequest("use my work email to reply to Ana"), "work");
    // "my own" is the person's. Read as a name, "own" was Enio's.
    assert.equal(acc.accountSwitchRequest("use my own account"), null);
    assert.equal(acc.ownerAsked("use my own account"), "user");
    assert.equal(acc.ownerWord("own"), null);
    // A phrase with the shape of a name matches no account, so nothing is
    // stored. Whether to SAY no such account exists: only behind "use" or
    // "switch to", and only for something short enough to be a name.
    const phrase = "Look in my documents folder for the calendar export from last year";
    assert.equal(acc.findAccountByName(acc.accountSwitchRequest(phrase)!), null);
    assert.equal(acc.explicitSwitch(phrase, acc.accountSwitchRequest(phrase)!), false);
    const words = "Use your own words, don't just copy my email";
    assert.equal(acc.explicitSwitch(words, acc.accountSwitchRequest(words)!), false);
    assert.equal(acc.explicitSwitch("check my zzz email", "zzz"), false);
    assert.equal(acc.explicitSwitch("use my zzz account", "zzz"), true);
  });

  test("an account labelled with an owner word is found by its label", () => {
    // "personal" is an owner word, and as one it returned whichever of the
    // person's accounts was connected first. Put the label on the second.
    const [, first, second] = acc.listAccounts();
    assert.deepEqual([first!.label, second!.label], ["personal", "work"]);
    acc.setAccountOwner(first!.id, "user", "main");
    acc.setAccountOwner(second!.id, "user", "personal");
    try {
      assert.equal(acc.findAccountByName("personal")!.email, second!.email);
    } finally {
      acc.setAccountOwner(first!.id, "user", "personal");
      acc.setAccountOwner(second!.id, "user", "work");
    }
  });

  test("the asked owner chooses whose mail and calendar this turn reads, and nothing else", () => {
    const [enio, mine, work] = acc.listAccounts();
    // Two more, so that a calendar write and a Drive read have somewhere
    // to go on each side: compared with nothing they would agree by absence.
    const full = ["mail.read", "mail.send", "calendar.read", "calendar.write", "drive.read"] as const;
    const enioFull = script("enio-full@example.com", { owner: "agent", label: "enio full", grants: [...full] });
    const mineFull = script("mine-full@example.com", { owner: "user", label: "mine full", grants: [...full] });
    try {
      // Nothing chosen. "your" reaches Enio's, which no fallback does.
      acc.setAskedOwner("agent");
      assert.equal(acc.scriptMailAccount("read")!.id, enio!.id);
      assert.equal(acc.scriptAccountWith("calendar.read")!.id, enio!.id);
      // Writing, sending, Drive, todos and contacts go where they went: a
      // grammar's guess does not send mail or add to a calendar, and it
      // does not steer a read whose result would not say whose it was.
      acc.setAskedOwner(null);
      const unsteered = () => ({
        send: acc.scriptMailAccount("send")!.id,
        write: acc.scriptAccountWith("calendar.write")!.id,
        drive: acc.scriptAccountWith("drive.read")!.id,
        todos: acc.scriptAccountWith(null)!.id,
      });
      for (const conversation of [null, enioFull.id, mineFull.id]) {
        acc.setActiveAccount(conversation);
        acc.setAskedOwner(null);
        const before = unsteered();
        for (const asked of ["agent", "user"] as const) {
          acc.setAskedOwner(asked);
          assert.deepEqual(unsteered(), before, `asked ${asked}, conversation ${conversation ?? "unset"}`);
        }
      }
      // The conversation is on Enio's by the person's choice; "my" reads
      // theirs this once, and the choice stands.
      acc.setActiveAccount(enio!.id);
      acc.setAskedOwner("user");
      assert.equal(acc.scriptMailAccount("read")!.id, mine!.id);
      acc.setAskedOwner(null);
      assert.equal(acc.scriptMailAccount("read")!.id, enio!.id, "the next turn, with no word, is back on the choice");
      // Among several of theirs: the conversation's, then the default.
      acc.setActiveAccount(work!.id);
      acc.setAskedOwner("user");
      assert.equal(acc.scriptMailAccount("read")!.id, work!.id);
      acc.setActiveAccount(enio!.id);
      acc.setDefaultAccount(work!.id);
      assert.equal(acc.scriptMailAccount("read")!.id, work!.id);
    } finally {
      acc.setDefaultAccount(null);
      acc.setActiveAccount(null);
      acc.setAskedOwner(null);
      acc.removeAccount(enioFull.id);
      acc.removeAccount(mineFull.id);
    }
  });

  test("the model's own my and your choose nothing; a name still does", async () => {
    // The argument is written by the model. Copied from the message, "my"
    // is the person's; spoken for itself -- its account reaches it as "my
    // own account" -- it is Enio's. Read as the person's every time, it
    // sent a search for Enio's inbox to theirs.
    const { mailTools } = await import("./tools/mail.js");
    const search = mailTools.find((t) => t.name === "search_email")!;
    const read = mailTools.find((t) => t.name === "read_email")!;
    const [enio] = acc.listAccounts();
    const calls = stubScript();
    try {
      // The conversation is on Enio's account, by the person's choice.
      acc.setActiveAccount(enio!.id);
      for (const account of ["my", "mine", "own", "my own", "your", "yours"]) {
        calls.length = 0;
        await search.run({ account });
        assert.match(calls[0]?.url ?? "", /enio@example\.com/, `account: "${account}" moved the search`);
      }
      // What has one meaning whoever says it still names an account.
      for (const account of ["personal", "the user's", "mariz@example.com"]) {
        calls.length = 0;
        const named = await search.run({ account });
        assert.match(calls[0]?.url ?? "", /mariz@example\.com/, account);
        // And nothing is said to have stood in: the account was named.
        assert.doesNotMatch(typeof named === "string" ? named : named.text, /No account of yours|no account of my own/);
      }
      // A search for a name that matches nothing is refused with the list;
      // opening a message is not, since the id says which one.
      const refused = await search.run({ account: "accounting" });
      assert.match(typeof refused === "string" ? refused : refused.text, /No connected account matches "accounting"/);
      calls.length = 0;
      await read.run({ id: "x9", account: "accounting" });
      assert.equal(calls.length, 1, "the read went ahead");
    } finally {
      acc.setActiveAccount(null);
      globalThis.fetch = realFetch;
    }
  });

  test("a message is opened in the mailbox it was listed from", async () => {
    // "check your email", then "read the second one": the second message
    // has no "your" in it, and the id went to whichever account the
    // conversation meant -- a message that is not there.
    const { mailTools } = await import("./tools/mail.js");
    const search = mailTools.find((t) => t.name === "search_email")!;
    const read = mailTools.find((t) => t.name === "read_email")!;
    const calls = stubScript([{ id: "enio-m2", from: "ana@example.com", subject: "Photos", date: "2026-11-27", snippet: "here" }]);
    try {
      acc.setAskedOwner("agent");
      await search.run({});
      assert.match(calls[0]!.url, /enio@example\.com/);
      // The next turn: no word about whose.
      acc.setAskedOwner(null);
      calls.length = 0;
      await read.run({ id: "enio-m2" });
      assert.match(calls[0]!.url, /enio@example\.com/, "opened where it was listed");
      // An id nothing listed is read the way it always was.
      calls.length = 0;
      await read.run({ id: "never-listed" });
      assert.match(calls[0]!.url, /mariz@example\.com/);
    } finally {
      acc.setAskedOwner(null);
      globalThis.fetch = realFetch;
    }
  });

  test("a turn: your reads Enio's for that turn, and the conversation stays where it was", async () => {
    // Through the turn loop, which is what sets the asked owner for the
    // tools: deleting that line passed every test that called them directly.
    const { runTurn } = await import("./agent.js");
    const { mailTools } = await import("./tools/mail.js");
    const registry = { all: mailTools, byName: new Map(mailTools.map((t) => [t.name, t])), dropped: [] };
    const sid = store.startSession();
    const turn = async (text: string, overrides: Record<string, unknown> = {}) => {
      const calls = stubScript([], [
        { tool: { name: "search_email", args: {} } },
        { content: "Nothing new there." },
      ]);
      const notices: string[] = [];
      await runTurn(text, [], registry, sid, { onNotice: (n) => notices.push(n) }, { specialist: "mail", ...overrides });
      return { searched: calls.find((c) => /script\.google\.com/.test(c.url))?.url ?? "", system: calls.system(), notices };
    };
    try {
      const yours = await turn("check your email");
      assert.match(yours.searched, /enio@example\.com/);
      assert.match(yours.system, /Enio's own account[^\n]*enio@example\.com[^\n]*being read for this request/, "the prompt names the account the tools read");
      assert.equal(acc.conversationAccount(sid), null, "nothing was stored on the conversation");
      assert.equal(yours.notices.filter((n) => /^Using /.test(n)).length, 0);

      // The next message names no one: back to what a conversation reads.
      const follow = await turn("anything from Ana?");
      assert.match(follow.searched, /mariz@example\.com/);

      // The same words in an automation step are the harness's, not a
      // person's.
      const step = await turn("check your email", { assembled: true });
      assert.match(step.searched, /mariz@example\.com/);

      // A phrase with the shape of a name is not one: it says nothing and
      // the possessive in it is still read.
      const latest = await turn("check your latest email");
      assert.match(latest.searched, /enio@example\.com/);
      assert.equal(latest.notices.filter((n) => /No connected account called/.test(n)).length, 0, latest.notices.join(" | "));
      const quiet = await turn("check my zzz email");
      assert.equal(quiet.notices.filter((n) => /No connected account called/.test(n)).length, 0, quiet.notices.join(" | "));
      const unknown = await turn("use my zzz account");
      assert.ok(unknown.notices.some((n) => /No connected account called "zzz"/.test(n)), unknown.notices.join(" | "));
      assert.equal(acc.conversationAccount(sid), null, "none of that stored anything");

      // A name is the move that is kept, in a step of an automation too:
      // its own prompt opens the text.
      const named = await turn("Check my work email for new invoices", { assembled: true });
      assert.ok(named.notices.some((n) => /^Using your account work/.test(n)), named.notices.join(" | "));
      assert.match(named.searched, /ro@example\.com/);
      assert.equal(acc.conversationAccount(sid), acc.findAccountByName("work")!.id);
      // And on the stored choice, "your" still reads Enio's for one turn.
      const once = await turn("anything in your inbox?");
      assert.match(once.searched, /enio@example\.com/);
      assert.match(once.system, /enio@example\.com[^\n]*being read for this request/);
      const after = await turn("anything from Ana?");
      assert.match(after.searched, /ro@example\.com/);
    } finally {
      acc.setActiveAccount(null);
      acc.setAskedOwner(null);
      globalThis.fetch = realFetch;
    }
  });

  test("a turn: the model's choice of account needs the person's words behind it", async () => {
    // Found on the real model, which a scripted one never showed: the mail
    // tool's `account` argument is for "when the user named one", and the
    // model fills it in from the account its own prompt names and from its
    // last call. A named account outranks the possessive, so "check my
    // email" read Enio's.
    const { runTurn } = await import("./agent.js");
    const { mailTools } = await import("./tools/mail.js");
    const registry = { all: mailTools, byName: new Map(mailTools.map((t) => [t.name, t])), dropped: [] };
    const sid = store.startSession();
    type Call = { name: string; args: Record<string, unknown> };
    /** Every script address the turn reached, in order. */
    const reached = async (text: string, calls: Call[], session = sid, overrides: Record<string, unknown> = {}) => {
      const seen = stubScript([], [...calls.map((tool) => ({ tool })), { content: "Nothing new there." }]);
      await runTurn(text, [], registry, session, {}, { specialist: "mail", ...overrides });
      return seen.filter((c) => /script\.google\.com/.test(c.url)).map((c) => /script\.google\.com\/([^/]+)\/exec/.exec(c.url)![1]!);
    };
    const searched = async (text: string, args: Record<string, unknown>, tool = "search_email") =>
      (await reached(text, [{ name: tool, args }]))[0] ?? "(no call)";
    const ENIO = "enio@example.com", MINE = "mariz@example.com", WORK = "ro@example.com";
    try {
      // Against the person's words: they said "my".
      assert.equal(await searched("check my email", { account: "enio's" }), MINE);
      assert.equal(await searched("check my email", { account: "enio@example.com" }), MINE);
      // With nothing of theirs behind it: the mailbox of the call before.
      assert.equal(await searched("any new mail?", { account: "enio's" }), MINE);
      // "You" in a request is not talk of a mailbox.
      assert.equal(await searched("can you find the invoice from Tom?", { account: "enio's" }), MINE);
      // "My" does not say which of theirs.
      assert.equal(await searched("ok now check my email", { account: "work" }), MINE);
      // A label nobody said is not refused either: there is no question
      // about "archive" to answer.
      assert.equal(await searched("any new mail?", { account: "archive" }), MINE);
      // Opening a message is held to the same.
      assert.equal(await searched("read the first one", { id: "never-listed", account: "enio's" }, "read_email"), MINE);

      // The name, said anywhere in the message, as the model wrote it or
      // as the account's label or address; a named account outranks the
      // possessive, which here says only "the person's".
      assert.equal(await searched("anything from Tom in my work inbox?", { account: "work" }), WORK);
      assert.equal(await searched("Anything from Tom in my Work inbox?", { account: "ro@example.com" }), WORK);
      assert.equal(await searched("anything new at ro@example.com?", { account: "work" }), WORK);
      assert.equal(await searched("check my inbox no wait the work one", { account: "work" }), WORK);
      assert.equal(acc.ownerAsked("is the quote in Enio’s?"), null, "the possessive rule is silent on this one");
      assert.equal(await searched("is the quote in Enio’s?", { account: "enio@example.com" }), ENIO);
      // Whole words, on both sides, and an argument is never a pattern.
      assert.equal(await searched("any mail about the homework?", { account: "work" }), MINE);
      assert.equal(await searched("is there a workshop invite?", { account: "work" }), MINE);
      assert.equal(await searched("any new mail?", { account: "work (old" }), MINE);

      // Talk of the owner, where the possessive rule heard nothing: the
      // model's reading is the only one there is, and it is wanted.
      for (const text of ["has Ana replied to you yet?", "did Enio get a reply from Sam?", "show me what's in your email"]) {
        assert.equal(acc.ownerAsked(text), null, text);
        assert.equal(await searched(text, { account: "enio's" }), ENIO, text);
      }
      // Both owners in one message choose no account for the turn, and
      // each call is the model's.
      assert.deepEqual(
        await reached("check my inbox, then check yours", [
          { name: "search_email", args: {} },
          { name: "search_email", args: { account: "enio's" } },
        ]),
        [MINE, ENIO],
      );
      // The mirror, in a conversation left on Enio's account.
      const onEnios = store.startSession();
      acc.setConversationAccount(onEnios, acc.listAccounts().find((a) => a.email === ENIO)!.id);
      assert.deepEqual(await reached("any mail for me today?", [{ name: "search_email", args: { account: "user's" } }], onEnios), [MINE]);
      assert.deepEqual(await reached("any new mail?", [{ name: "search_email", args: { account: "user's" } }], onEnios), [ENIO]);

      // A name the person typed that matches nothing is refused with the
      // list, and the model's pick from that list is then let through:
      // dropped, the refusal ended in a quiet read of the default mailbox.
      assert.equal(await searched("anything in my archive inbox?", { account: "archive" }), "(no call)");
      assert.deepEqual(
        await reached("search my wrk inbox for the receipt", [
          { name: "search_email", args: { account: "wrk" } },
          { name: "search_email", args: { account: "work" } },
        ]),
        [WORK],
      );
      assert.equal(acc.conversationAccount(sid), null, "none of it was stored");

      // An automation step's text is a prompt and other steps' replies,
      // nobody's words: the argument stands there as it always did.
      assert.equal((await reached("Summarise new mail", [{ name: "search_email", args: { account: "enio's" } }], sid, { assembled: true }))[0], ENIO);

      // The turn's words end with the turn, however it ends. Outside one
      // there is no message to hold an argument to: a tool step of an
      // automation carries an argument a person typed.
      assert.equal(await searched("check your email", {}), ENIO);
      assert.equal(acc.turnMessageNow(), null);
      assert.equal(acc.askedOwnerThisTurn(), null);
      stubScript([], [{ tool: { name: "search_email", args: {} } }]);
      await assert.rejects(runTurn("check your email", [], registry, sid, { shouldStop: () => true }, { specialist: "mail" }));
      assert.equal(acc.turnMessageNow(), null, "a stopped turn leaves nothing behind");
      assert.equal(acc.askedOwnerThisTurn(), null);
      const search = mailTools.find((t) => t.name === "search_email")!;
      const direct = stubScript();
      await search.run({ account: "enio's" });
      await search.run({});
      assert.match(direct[0]!.url, /enio@example\.com/);
      assert.match(direct[1]!.url, /mariz@example\.com/);

      // A turn started inside this one (run_pipeline runs its steps as
      // turns) hands the outer turn its words back.
      const inner = {
        name: "search_drive",
        description: "stand-in",
        origin: "builtin" as const,
        parameters: { type: "object" as const, properties: {}, required: [] },
        run: async () => {
          await runTurn("Check the work inbox", [], registry, store.startSession(), {}, { specialist: "mail", assembled: true });
          return "ran a step";
        },
      };
      const nested = { all: [...mailTools, inner], byName: new Map([...mailTools, inner].map((t) => [t.name, t])), dropped: [] };
      const seen = stubScript([], [
        { tool: { name: "search_drive", args: {} } },
        { content: "step done" },
        { tool: { name: "search_email", args: {} } },
        { content: "Nothing new there." },
      ]);
      await runTurn("check your email", [], nested as never, sid, {}, { specialist: "mail" });
      assert.match(seen.find((c) => /script\.google\.com/.test(c.url))?.url ?? "", /enio@example\.com/, "the outer turn still reads what it was asked");
    } finally {
      acc.setActiveAccount(null);
      acc.setAskedOwner(null);
      acc.setTurnMessage(null);
      globalThis.fetch = realFetch;
    }
  });

  test("the person's words behind a name: spelling, addresses, and what is not a name", async () => {
    const said = (message: string, argument: string, account: Record<string, unknown> | null, heard: "agent" | "user" | null = null) => {
      acc.setAskedOwner(heard);
      acc.setTurnMessage(message);
      try {
        return acc.personNamed(argument, account as never);
      } finally {
        acc.setTurnMessage(null);
        acc.setAskedOwner(null);
      }
    };
    const work = { email: "ro@acme.com", label: "work", owner: "user" };
    // Accents, case, apostrophes and runs of spaces are not differences.
    assert.ok(said("tem algo novo no email do escritorio?", "Escritório", { email: "x@firma.pt", label: "Escritório", owner: "user" }));
    assert.ok(said("check my old   work inbox", "old work", { email: "o@acme.com", label: "old work", owner: "user" }));
    // The part of an address that says whose it is, and not the provider.
    assert.ok(said("anything in the acme inbox from Bob?", "work", work));
    assert.ok(!said("anything in my gmail from Bob?", "work", { email: "ro@gmail.com", label: "work", owner: "user" }));
    assert.ok(!said("any mail from Bob?", "work", work));
    assert.ok(said("anything new at ro@gmail.com?", "work", { email: "ro@gmail.com", label: "work", owner: "user" }), "the address itself");
    assert.ok(said("anything in the O\u2019Brien inbox?", "o'brien", { email: "x@firma.pt", label: "O'Brien", owner: "user" }));
    // Enio's own, by talk of Enio; never against what the person's
    // possessive said, and never on a bare "you".
    const enio = { email: "bot@acme.io", label: "robot", owner: "agent" };
    assert.ok(said("did anything come in for you overnight?", "robot", enio));
    assert.ok(said("what did Lena send to Enio?", "bot@acme.io", enio));
    assert.ok(!said("could you check for me whether Bob wrote", "robot", enio));
    assert.ok(!said("not your inbox, check my email", "robot", enio, "user"));
    // An owner word for the person's own, by "my" or "me"; a label of
    // theirs is not an owner word.
    assert.ok(said("any mail for me today?", "user's", null));
    assert.ok(!said("any mail today?", "user's", null));
    assert.ok(!said("did anyone write to you about me?", "user's", null, "agent"));
    assert.ok(!said("check my email", "work", work, "user"));
    // Outside a turn there is nothing to hold it to.
    assert.ok(acc.personNamed("anything", null));
  });

  test("an account the model asked for and did not get: the result says whose it read", async () => {
    // Otherwise the result gives an address and no owner, and the model
    // describes the mailbox it asked for.
    const { mailTools } = await import("./tools/mail.js");
    const search = mailTools.find((t) => t.name === "search_email")!;
    const text = (out: unknown) => (typeof out === "string" ? out : (out as { text: string }).text);
    stubScript([{ id: "m1", from: "a", subject: "s", date: "2026-11-27", snippet: "x" }]);
    try {
      acc.setActiveAccount(acc.listAccounts().find((a) => a.email === "enio@example.com")!.id);
      acc.setTurnMessage("any new mail?");
      assert.match(text(await search.run({ account: "user's" })), /^This is my own account[^\n]*enio@example\.com/);
      assert.match(text(await search.run({ account: "work" })), /^This is my own account/);
      // Nothing was asked for, or what was asked for is what was read.
      assert.doesNotMatch(text(await search.run({})), /^This is/);
      assert.doesNotMatch(text(await search.run({ account: "enio's" })), /^This is/);
    } finally {
      acc.setActiveAccount(null);
      acc.setTurnMessage(null);
      globalThis.fetch = realFetch;
    }
  });

  test("a step of an automation uses the account it is set to, or says why it cannot", async () => {
    // A step runs with no conversation behind it and no person's words in
    // it, so nothing above reaches it: which account it uses is a setting
    // on the step, picked from a list.
    const pipelines = await import("./pipelines.js");
    const { mailTools } = await import("./tools/mail.js");
    const { emailTools } = await import("./tools/email.js");
    const tools = [...mailTools, ...emailTools];
    const registry = { all: tools, byName: new Map(tools.map((t) => [t.name, t])), dropped: [] };
    const ENIO = "enio@example.com", MINE = "mariz@example.com", WORK = "ro@example.com";
    const workId = acc.findAccountByName("work")!.id;
    let n = 0;
    type Step = { abilityId?: string; prompt?: string; account?: string; args?: Record<string, unknown>; tool?: string };
    /** Run the steps as one automation; which mailboxes were reached, and how each step ended. */
    const run = async (steps: Step[]) => {
      const saved = pipelines.savePipeline({
        name: `step-account-${++n}`,
        nodes: steps.map((st, i) => ({
          id: `n${i + 1}`,
          abilityId: st.abilityId ?? "read-email",
          prompt: st.prompt ?? "Summarise new mail",
          ...(st.account ? { account: st.account } : {}),
        })),
        edges: [],
      });
      const seen = stubScript([], steps.flatMap((st) => [{ tool: { name: st.tool ?? "search_email", args: st.args ?? {} } }, { content: "Done." }]));
      const failed: string[] = [];
      const result = await pipelines.runPipeline(saved, registry as never, (event) => {
        if (event.type === "node_failed") failed.push(event.error);
      });
      return {
        status: result.status,
        failed,
        reached: seen.filter((c) => /script\.google\.com/.test(c.url)).map((c) => /script\.google\.com\/([^/]+)\/exec/.exec(c.url)![1]!),
      };
    };
    try {
      // The three kinds of choice.
      assert.deepEqual((await run([{ account: "agent" }])).reached, [ENIO]);
      assert.deepEqual((await run([{ account: "user" }])).reached, [MINE]);
      assert.deepEqual((await run([{ account: workId }])).reached, [WORK]);
      // And none: what a conversation would use.
      assert.deepEqual((await run([{}])).reached, [MINE]);

      // The setting is the choice. A name at the start of the step's own
      // prompt does not switch away from it, and neither does an account
      // the model names in its call.
      assert.deepEqual((await run([{ account: "agent", prompt: "Check my work email for invoices" }])).reached, [ENIO]);
      assert.deepEqual((await run([{ account: "agent", args: { account: "work" } }])).reached, [ENIO]);
      assert.deepEqual((await run([{ account: workId, args: { account: "enio's" } }])).reached, [WORK]);
      // Without a setting both still do, as before.
      assert.deepEqual((await run([{ prompt: "Check my work email for invoices" }])).reached, [WORK]);
      assert.deepEqual((await run([{ args: { account: "work" } }])).reached, [WORK]);

      // Each step starts from no account of its own: a name in step one's
      // prompt used to be kept on the run's session and chose for step two.
      assert.deepEqual((await run([{ prompt: "Check my work email for invoices" }, {}])).reached, [WORK, MINE]);
      assert.deepEqual((await run([{ account: "agent" }, {}, { account: workId }])).reached, [ENIO, MINE, WORK]);

      // An account that is gone, or cannot do what the step is for: the
      // step fails and says so. Nothing else is read or sent in its place.
      const gone = await run([{ account: "deadbeefdeadbeef" }]);
      assert.equal(gone.status, "failed");
      assert.deepEqual(gone.reached, []);
      assert.match(gone.failed[0]!, /^This step is set to use an account that is no longer connected\. Choose another account for this step/);
      const cannot = await run([{ abilityId: "send-email", account: workId, tool: "send_email", args: { to: "ana@example.net", subject: "s", body: "b" } }]);
      assert.equal(cannot.status, "failed");
      assert.match(cannot.failed[0]!, /^This step is set to use your account work \(ro@example\.com\), which is connected without permission to send mail\./);

      // A name in a set step's prompt is not a switch at all: nothing is
      // stored on the session and nothing is announced.
      const { runTurn } = await import("./agent.js");
      const sid = store.startSession();
      const seen = stubScript([], [{ tool: { name: "search_email", args: {} } }, { content: "Done." }]);
      const notices: string[] = [];
      const enioId = acc.listAccounts().find((a) => a.email === ENIO)!.id;
      await runTurn("Check my work email for invoices", [], registry as never, sid, { onNotice: (x) => notices.push(x) }, { specialist: "mail", assembled: true, account: enioId });
      assert.match(seen.find((c) => /script\.google\.com/.test(c.url))?.url ?? "", /enio@example\.com/);
      assert.equal(acc.conversationAccount(sid), null);
      assert.deepEqual(notices.filter((x) => /^Using /.test(x)), []);

      // After a run the turn's account state is as it was before it.
      assert.equal(acc.activeAccount(), null);
      assert.equal(acc.pinnedAccountNow(), null);
    } finally {
      acc.setActiveAccount(null);
      acc.setPinnedAccount(null);
      globalThis.fetch = realFetch;
    }
  });

  test("two turns at once each keep their own account", async () => {
    // A chat turn and a step of a scheduled automation run in one
    // process. With the state in module variables saved and put back
    // around each turn, the chat turn ended while the step waited on the
    // model, put back what it had found, and the step's next call read
    // the person's mailbox where it was set to Enio's.
    const { runTurn } = await import("./agent.js");
    const { mailTools } = await import("./tools/mail.js");
    const registry = { all: mailTools, byName: new Map(mailTools.map((t) => [t.name, t])), dropped: [] };
    const enioId = acc.listAccounts().find((a) => a.email === "enio@example.com")!.id;
    const reached: Array<{ who: string; url: string }> = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const counts: Record<string, number> = { step: 0, chat: 0 };
    const stream = (delta: unknown) =>
      new Response(
        new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200 },
      );
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const address = String(url);
      const body = String(init?.body ?? "{}");
      if (/script\.google\.com/.test(address)) {
        // Which turn made the call is in the async context, not the URL:
        // the step's tool call carries the query it was scripted with.
        reached.push({ who: /stepquery/.test(body) ? "step" : "chat", url: address });
        return new Response(JSON.stringify({ ok: [] }), { status: 200 });
      }
      if (/huggingface/.test(address)) throw new Error("no network in tests");
      const who = /Summarise the step inbox/.test(body) ? "step" : "chat";
      const n = counts[who]!++;
      // The step's first model call waits until the chat turn is over.
      if (who === "step" && n === 0) await held;
      if (n === 0) return stream({ tool_calls: [{ index: 0, id: "c1", function: { name: "search_email", arguments: JSON.stringify(who === "step" ? { query: "stepquery" } : {}) } }] });
      return stream({ content: "Done." });
    }) as typeof fetch;
    try {
      const step = runTurn("Summarise the step inbox", [], registry as never, store.startSession(), {}, { specialist: "mail", assembled: true, account: enioId });
      await new Promise((r) => setTimeout(r, 20));
      await runTurn("any new mail?", [], registry as never, store.startSession(), {}, { specialist: "mail" });
      release();
      await step;
      assert.match(reached.find((r) => r.who === "chat")!.url, /mariz@example\.com/, "the chat turn read what a conversation reads");
      assert.match(reached.find((r) => r.who === "step")!.url, /enio@example\.com/, "and the step read the account it is set to");
      // Neither left anything behind.
      assert.equal(acc.activeAccount(), null);
      assert.equal(acc.pinnedAccountNow(), null);
    } finally {
      release();
      globalThis.fetch = realFetch;
    }
  });

  test("a step's account: the choices, their resolution, and a tool held to it", async () => {
    const pipelines = await import("./pipelines.js");
    const { emailTools } = await import("./tools/email.js");
    const step = (account: unknown) => pipelines.validatePipeline([{ id: "n1", abilityId: "read-email", prompt: "x", account: account as string }], []);
    const workId = acc.findAccountByName("work")!.id;
    // A closed shape on save: an owner, or an id. Not a label, not a sentence.
    for (const ok of ["agent", "user", workId]) assert.equal(step(ok).ok, true, ok);
    for (const bad of ["work", "enio's", "", "mine", 7, "agent; drop"]) {
      const v = step(bad);
      assert.ok(!v.ok && /account setting that is not one of the choices/.test(v.reason), String(bad));
    }
    // What is typed at the command line becomes one of them.
    assert.equal(acc.stepAccountFor("enio"), "agent");
    // An account's own label is that account, before it is an owner word.
    assert.equal(acc.stepAccountFor("Enio’s"), acc.listAccounts().find((a) => a.email === "enio@example.com")!.id);
    assert.equal(acc.stepAccountFor("agent"), "agent");
    assert.equal(acc.stepAccountFor("mine"), "user");
    assert.equal(acc.stepAccountFor("work"), workId);
    assert.equal(acc.stepAccountFor("ro@example.com"), workId);
    assert.equal(acc.stepAccountFor("accounting"), null);
    assert.equal(acc.stepAccountFor(""), null);

    // "Mine" is the person's default account when they have one, and an
    // owner whose account lacks the grant is a reason, not a fallback.
    assert.equal((acc.stepAccount("user", "mail.read") as { account: { email: string } }).account.email, "mariz@example.com");
    acc.setDefaultAccount(workId);
    try {
      assert.equal((acc.stepAccount("user", "mail.read") as { account: { email: string } }).account.email, "ro@example.com");
      // The default cannot send; another of theirs can, and is theirs too.
      const sends = acc.stepAccount("user", "mail.send");
      assert.equal(sends.ok && sends.account.email, "mariz@example.com");
    } finally {
      acc.setDefaultAccount(null);
    }
    const drive = acc.stepAccount("agent", "drive.read");
    assert.ok(!drive.ok && /Enio's own account[^.]*enio@example\.com\), which is connected without permission to read Drive/.test(drive.reason), JSON.stringify(drive));
    assert.equal(acc.stepAccount("agent", null).ok, true);

    // Held to it at the tool: an account that cannot send is not replaced
    // by another sender.
    const send = emailTools.find((t) => t.name === "send_email")!;
    acc.setActiveAccount(workId);
    acc.setPinnedAccount(workId);
    try {
      const out = await send.run({ to: "ana@example.net", subject: "s", body: "b" });
      assert.match(typeof out === "string" ? out : out.text, /^This step is set to an account that cannot send mail, so nothing was written\./);
      // And a model-named account counts only when it is that account.
      assert.equal(acc.personNamed("enio's", acc.findAccountByName("enio's")), false);
      assert.equal(acc.personNamed("work", acc.findAccountByName("work")), true);
    } finally {
      acc.setActiveAccount(null);
      acc.setPinnedAccount(null);
    }

    // Only a step that uses an account can be set to one.
    const stray = pipelines.validatePipeline([{ id: "n1", abilityId: "prompt", prompt: "Write a haiku", account: "agent" }], []);
    assert.ok(!stray.ok && /is set to an account, and a ".*" step uses none/.test(stray.reason), JSON.stringify(stray));

    // Nothing stands in for the account a step is set to. Enio's own does
    // not: a calendar step set to the person's account wrote the event to
    // Enio's calendar when theirs could not be written to.
    const { mailTools } = await import("./tools/mail.js");
    const google = await import("./tools/google.js");
    const text = (out: unknown) => (typeof out === "string" ? out : (out as { text: string }).text);
    assert.ok(acc.agentOnlyAccount("calendar.read"), "outside a set step Enio's own may stand in");
    const sendOnly = script("sendonly@example.com", { owner: "user", label: "sendonly", grants: ["mail.send"] });
    acc.setAccountOwner(sendOnly.id, "user", "sendonly");
    const calls = stubScript([{ id: "listed-in-enio", from: "a", subject: "s", date: "2026-11-27", snippet: "x" }]);
    try {
      // An id listed from Enio's mailbox, before any step is set.
      acc.setActiveAccount(acc.listAccounts().find((a) => a.email === "enio@example.com")!.id);
      await mailTools.find((t) => t.name === "search_email")!.run({});
      const listedCalls = calls.length;

      acc.setActiveAccount(workId);
      acc.setPinnedAccount(workId);
      assert.equal(acc.agentOnlyAccount("calendar.read"), null);
      assert.equal(acc.agentOnlyMailAccount(), null);
      const calendar = google.refreshGoogleTools().find((t) => t.name === "read_calendar")!;
      assert.match(text(await calendar.run({})), /^This step is set to an account that cannot do that, so nothing was done\./);
      // It opens what its own account listed, not an id from another mailbox.
      assert.match(text(await mailTools.find((t) => t.name === "read_email")!.run({ id: "listed-in-enio" })), /^That message was listed from another account, and this step is set to one\./);
      // And an account that cannot read mail reads none: not IMAP, not a
      // message about accounts nobody asked about.
      acc.setActiveAccount(sendOnly.id);
      acc.setPinnedAccount(sendOnly.id);
      assert.match(text(await mailTools.find((t) => t.name === "search_email")!.run({})), /^This step is set to an account that cannot read mail, so nothing was read\./);
      assert.equal(calls.length, listedCalls, "no mailbox was reached by any of the three");
    } finally {
      acc.setActiveAccount(null);
      acc.setPinnedAccount(null);
      acc.removeAccount(sendOnly.id);
      globalThis.fetch = realFetch;
    }

    // The composer's examples never show which account a step was set to.
    const saved = pipelines.savePipeline({ name: "example-with-account", nodes: [{ id: "n1", abilityId: "read-email", prompt: "x", account: "agent" }], edges: [] });
    assert.equal(pipelines.getPipeline(saved.id)!.nodes[0]!.account, "agent", "the setting is stored");
    const { getDb } = await import("./memory/db.js");
    getDb().prepare(`INSERT INTO pipeline_runs (id, pipeline_id, started_at, finished_at, status, node_results) VALUES (?, ?, ?, ?, 'succeeded', '[]')`).run("vouch-example", saved.id, Date.now(), Date.now());
    const example = pipelines.loadPipelineExamples().find((e) => e.name === "example-with-account");
    assert.ok(example, "a vouched automation is an example");
    assert.equal("account" in example!.nodes[0]!, false);
  });

  test("a turn: asked for a mailbox and answered without looking in it, the harness looks", async () => {
    // Also from the real model. The picker had the right account and no
    // call reached it: the model answered "did anyone write to you?" from
    // the work inbox already in the conversation, and "check my email" by
    // opening a message it had listed from Enio's.
    const { runTurn } = await import("./agent.js");
    const { mailTools } = await import("./tools/mail.js");
    const registry = { all: mailTools, byName: new Map(mailTools.map((t) => [t.name, t])), dropped: [] };
    const sid = store.startSession();
    type Reply = { content?: string; tool?: { name: string; args: unknown } };
    const turn = async (text: string, model: Reply[], overrides: Record<string, unknown> = {}) => {
      const calls = stubScript([{ id: "enio-m7", from: "lena@example.com", subject: "Quote", date: "2026-11-27", snippet: "4,300" }], model);
      const notices: string[] = [];
      const result = await runTurn(text, [], registry, sid, { onNotice: (n) => notices.push(n) }, { specialist: "mail", ...overrides });
      return { urls: calls.filter((c) => /script\.google\.com/.test(c.url)).map((c) => c.url), notices, reply: result.reply };
    };
    const looked = (notices: string[]) => notices.filter((n) => /came without looking in/.test(n));
    try {
      // No call at all: the search is made for it, in the mailbox asked for.
      const none = await turn("did anyone write to you?", [
        { content: "Yes, Tom Hale wrote about the invoice." },
        { content: "In my own inbox there is one message, from Lena." },
      ]);
      assert.equal(none.urls.length, 1);
      assert.match(none.urls[0]!, /enio@example\.com/);
      assert.match(looked(none.notices).join(), /Enio's own mailbox/);
      assert.equal(none.reply, "In my own inbox there is one message, from Lena.", "the first answer is withdrawn");

      // Looked in the mailbox asked for, by search or by opening a message
      // listed from it: nothing to correct.
      const opened = await turn("anything in your inbox from Lena?", [
        { tool: { name: "read_email", args: { id: "enio-m7" } } },
        { content: "Lena sent me a quote." },
      ]);
      assert.deepEqual(looked(opened.notices), []);
      assert.equal(opened.urls.length, 1);
      // A call, to the other owner's mailbox: a message listed from Enio's
      // (above) opened again and presented as the person's. After the
      // case before it, because the stand-in script lists the same id from
      // every mailbox and the search made here re-homes it.
      const other = await turn("check my email", [
        { tool: { name: "read_email", args: { id: "enio-m7" } } },
        { content: "You have a message from Lena about a quote." },
        { content: "Your inbox has one message." },
      ]);
      assert.match(other.urls[0]!, /enio@example\.com/, "the listed id opens in its own mailbox");
      assert.match(other.urls.at(-1)!, /mariz@example\.com/, "and then the mailbox that was asked for is searched");
      assert.match(looked(other.notices).join(), /your mailbox/);
      assert.equal(other.reply, "Your inbox has one message.");

      // A search of it, the ordinary case, is of course a look.
      const searchedIt = await turn("check your email", [
        { tool: { name: "search_email", args: {} } },
        { content: "One message in my inbox." },
      ]);
      assert.deepEqual(looked(searchedIt.notices), []);
      assert.equal(searchedIt.urls.length, 1);
      // No owner asked: an answer from the conversation is left alone.
      const plain = await turn("what did Lena say?", [{ content: "She quoted 4,300." }]);
      assert.deepEqual(looked(plain.notices), []);
      assert.equal(plain.urls.length, 0);
      // An automation step's words are not a person asking.
      const step = await turn("did anyone write to you?", [{ content: "Nobody." }], { assembled: true });
      assert.deepEqual(looked(step.notices), []);
    } finally {
      acc.setActiveAccount(null);
      acc.setAskedOwner(null);
      acc.setTurnMessage(null);
      acc.setTurnMailReads([]);
      globalThis.fetch = realFetch;
    }
  });

  test("asked for an owner with nothing of theirs to read: said, or not read", async () => {
    const { mailTools } = await import("./tools/mail.js");
    const search = mailTools.find((t) => t.name === "search_email")!;
    const all = acc.listAccounts();
    const enio = all.find((a) => a.owner === "agent")!;
    const theirs = all.filter((a) => a.owner === "user");
    const calls = stubScript();
    const put = (a: (typeof all)[number]) =>
      void acc.setAccountOwner(script(a.email, { grants: a.grants }).id, a.owner!, a.label);
    try {
      // Only Enio's is connected and the conversation was left on it.
      // Asked for THEIRS, Enio's inbox is not read as theirs.
      for (const a of theirs) acc.removeAccount(a.id);
      acc.setActiveAccount(enio.id);
      acc.setAskedOwner("user");
      const refused = await search.run({});
      assert.match(typeof refused === "string" ? refused : refused.text, /No account of yours is connected/);
      assert.equal(calls.length, 0, "Enio's inbox was not read as theirs");
      acc.setActiveAccount(null);
      // And through a turn: with nothing of theirs to look in, there is
      // nothing for the harness to go and read either. The tool's own
      // answer is the one that says so.
      {
        const { runTurn } = await import("./agent.js");
        const registry = { all: mailTools, byName: new Map(mailTools.map((t) => [t.name, t])), dropped: [] };
        const turnCalls = stubScript([], [{ content: "Nothing new." }]);
        const notices: string[] = [];
        await runTurn("check my email", [], registry, store.startSession(), { onNotice: (n) => notices.push(n) }, { specialist: "mail" });
        assert.deepEqual(notices.filter((n) => /came without looking in/.test(n)), []);
        assert.equal(turnCalls.filter((c) => /script\.google\.com/.test(c.url)).length, 0);
      }
      for (const a of theirs) put(a);

      // Only theirs is connected. Asked for ENIO'S, theirs is read and the
      // result says what it is.
      acc.removeAccount(enio.id);
      acc.setAskedOwner("agent");
      const later = stubScript();
      const stoodIn = await search.run({});
      assert.match(typeof stoodIn === "string" ? stoodIn : stoodIn.text, /no account of my own that can read mail — this is your account personal/);
      assert.match(later[0]!.url, /mariz@example\.com/);
    } finally {
      acc.setAskedOwner(null);
      acc.setActiveAccount(null);
      globalThis.fetch = realFetch;
      if (!acc.listAccounts().some((a) => a.owner === "agent")) put(enio);
      for (const a of theirs) if (!acc.listAccounts().some((x) => x.email === a.email)) put(a);
    }
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
