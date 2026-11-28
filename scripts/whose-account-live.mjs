/**
 * "My" and "your" on the real model, against mailboxes that do not exist.
 *
 *   npm run build && node scripts/whose-account-live.mjs [passes] [out.json] [accounts|send]
 *
 * Needs the model server. The whole turn runs as the app runs it -- the
 * router, the mail or planner agent, the model -- and only the Apps Script
 * bridge is replaced, so which account each call reached is a recorded
 * fact and no real mailbox is touched. Three accounts are connected in a
 * scratch data dir: Enio's own, the person's, and the person's "work".
 *
 * This is what scripts/whose-account-data.json cannot show. That file
 * scores the grammar on a message; this shows what the model does with
 * the account once the grammar has spoken -- and it was the model, not
 * the grammar, that read the wrong mailbox the first time this ran
 * (DECISIONS.md, "On the model").
 *
 * `send` replays writing and sending instead (DECISIONS.md, "A message
 * being written"): a fresh send, a reply after reading, a draft revised
 * twice, and plain questions that only contain a composing verb. Nothing
 * there is judged by account, so every turn is "recorded": read the tools
 * it ran, the corrections the harness made and the reply. Sending is
 * switched ON for that set, because send_email no longer sends (outbox.ts)
 * and this is where that is checked on the model: each turn records the
 * messages left waiting, and the run fails loudly if any turn reached the
 * bridge's mail.send.
 *
 * A turn is "right" when every mail or calendar call it made reached the
 * account in the table below, "wrong" when none did, and "no call" when
 * it answered without one. "No call" is not a failure by itself: read the
 * reply. A message opened the turn before is fairly answered from the
 * conversation.
 */
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
if (!existsSync(join(repo, "dist", "agent.js"))) {
  console.error("dist/agent.js is missing — run `npm run build` first.");
  process.exit(1);
}
const REPS = Number(process.argv[2] ?? 3);
const outFile = process.argv[3] ?? join(tmpdir(), "whose-account-live.json");
const SET = process.argv[4] === "send" ? "send" : "accounts";

// The model the app is using, read before the machine state is redirected
// away from it. An explicit ENIO_BASE_URL or ENIO_MODEL wins.
try {
  const state = process.env.ENIO_MACHINE_STATE_DIR ?? join(homedir(), ".enio");
  const chosen = JSON.parse(readFileSync(join(state, "model.json"), "utf8"));
  if (chosen.baseUrl) process.env.ENIO_BASE_URL ??= chosen.baseUrl;
  if (chosen.model) process.env.ENIO_MODEL ??= chosen.model;
} catch {
  /* No setting: the backend's default address and model. */
}

const scratch = mkdtempSync(join(tmpdir(), "enio-whose-live-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
if (SET === "send") process.env.ENIO_EMAIL_SEND = "1";
else delete process.env.ENIO_EMAIL_SEND;
for (const d of ["data", "ws", "skills", "machine"]) mkdirSync(join(scratch, d), { recursive: true });
// The embedding model is already on this machine; linked so that routing
// takes the same fast tier the app does, with nothing downloaded.
const cache = join(homedir(), ".enio", "embeddings-cache");
if (existsSync(cache)) symlinkSync(cache, join(scratch, "data", "embeddings-cache"));

const dist = (f) => pathToFileURL(join(repo, "dist", f)).href;
const acc = await import(dist("accounts.js"));
const store = await import(dist("memory/store.js"));

const ALL = ["mail.read", "mail.send", "calendar.read", "calendar.write"];
const add = (email, owner, label) =>
  acc.addScriptAccount({ email, url: `https://script.google.com/${email}/exec`, secret: "s", version: 5, grants: ALL, owner, label });
add("enio@example.com", "agent", "Enio's");
const home = add("sam@example.com", "user");
add("sam@northwind.example", "user", "work");
acc.setDefaultAccount(null);
void home;

const BOX = {
  "enio@example.com": {
    mail: [
      { id: "e1", from: "Lena Fischer <lena@armworks.example>", subject: "Robot arm quote", date: "2026-11-27T09:12:00Z", snippet: "The six-axis arm comes to 4,300 euros before shipping." },
      { id: "e2", from: "GitHub <noreply@github.example>", subject: "[enio] build passed", date: "2026-11-26T18:40:00Z", snippet: "All checks have passed on master." },
      { id: "e3", from: "Storage Team <storage@cloud.example>", subject: "Your storage summary", date: "2026-11-25T07:00:00Z", snippet: "You are using 2 GB of 15 GB." },
    ],
    bodies: {
      e1: "Hello Enio,\n\nThe six-axis arm comes to 4,300 euros before shipping. Delivery is three weeks.\n\nLena",
      e2: "All checks have passed on master.",
      e3: "You are using 2 GB of 15 GB.",
    },
    events: [{ title: "Weekly model evaluation", start: "2026-11-30T10:00:00", end: "2026-11-30T11:00:00" }],
  },
  "sam@example.com": {
    mail: [
      { id: "p1", from: "Ana Costa <ana@example.net>", subject: "Dinner on Friday?", date: "2026-11-27T08:02:00Z", snippet: "Are you free at eight? I booked the place by the river." },
      { id: "p2", from: "Banco do Douro <no-reply@douro.example>", subject: "Your statement is ready", date: "2026-11-26T06:30:00Z", snippet: "Your November statement can be viewed online." },
      { id: "p3", from: "Clinica Reis <agenda@reis.example>", subject: "Appointment reminder", date: "2026-11-24T12:00:00Z", snippet: "You have an appointment on 2 December at 15:30." },
    ],
    bodies: {
      p1: "Hi Sam,\n\nAre you free at eight? I booked the place by the river.\n\nAna",
      p2: "Your November statement can be viewed online.",
      p3: "You have an appointment on 2 December at 15:30.",
    },
    events: [
      { title: "Dentist", start: "2026-11-30T15:30:00", end: "2026-11-30T16:00:00" },
      { title: "Dinner with Ana", start: "2026-12-04T20:00:00", end: "2026-12-04T22:00:00" },
    ],
  },
  "sam@northwind.example": {
    mail: [
      { id: "w1", from: "Tom Hale <tom@northwind.example>", subject: "Q4 invoice 4471", date: "2026-11-27T10:15:00Z", snippet: "Attached is invoice 4471 for the fourth quarter, due 15 December." },
      { id: "w2", from: "People Team <people@northwind.example>", subject: "Holiday schedule", date: "2026-11-25T09:00:00Z", snippet: "The office closes from 24 December to 2 January." },
    ],
    bodies: { w1: "Attached is invoice 4471 for the fourth quarter, due 15 December.", w2: "The office closes from 24 December to 2 January." },
    events: [{ title: "Quarterly planning", start: "2026-12-01T09:00:00", end: "2026-12-01T12:00:00" }],
  },
};

let bridge = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const address = String(url);
  const m = /script\.google\.com\/([^/]+)\/exec/.exec(address);
  if (m) {
    const email = decodeURIComponent(m[1]);
    const { op, args } = JSON.parse(String(init?.body ?? "{}"));
    bridge.push({ email, op, args });
    const box = BOX[email];
    const ok = (v) => new Response(JSON.stringify({ ok: v }), { status: 200 });
    if (op === "mail.recent") {
      const q = String(args?.query ?? "");
      const from = /from:(\S+)/i.exec(q)?.[1]?.toLowerCase();
      const words = q.replace(/\b(?:from|newer_than|in):\S+/gi, " ").toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const rows = box.mail.filter((r) => {
        const hay = `${r.from} ${r.subject} ${r.snippet}`.toLowerCase();
        return (!from || r.from.toLowerCase().includes(from)) && words.every((w) => hay.includes(w));
      });
      return ok(rows);
    }
    if (op === "mail.read") {
      const row = box.mail.find((r) => r.id === args?.id);
      // A message is only in its own mailbox, as on Google.
      if (!row) return new Response(JSON.stringify({ error: `No message ${args?.id} in this mailbox.` }), { status: 200 });
      return ok({ from: row.from, to: email, date: row.date, subject: row.subject, body: box.bodies[row.id] });
    }
    if (op === "calendar.upcoming") return ok(box.events);
    if (op === "calendar.add") return ok({ title: args?.title ?? "" });
    if (op === "mail.send") return ok(true);
    return ok([]);
  }
  if (/huggingface/.test(address)) throw new Error("no network in this run");
  return realFetch(url, init);
};

/**
 * Each conversation is a list of [message, what the bridge should have
 * been asked, on whose account]. `null` for the account means the turn is
 * recorded, not judged: which account a send or a calendar entry uses is
 * not this change's to steer.
 */
const E = "enio@example.com", P = "sam@example.com", W = "sam@northwind.example";
const ACCOUNTS = {
  mail: [
    ["check your email", "mail.recent", E],
    ["open the one about the robot arm quote", "mail.read", E],
    ["ok now check my email", "mail.recent", P],
    ["what does Ana say?", "mail.read", P],
    ["anything in your inbox from GitHub?", "mail.recent", E],
    ["any new mail?", "mail.recent", P],
  ],
  calendar: [
    ["what's on my calendar this week?", "calendar.upcoming", P],
    ["and what's on your calendar?", "calendar.upcoming", E],
    ["add lunch with Ana to my calendar on 2 December from 13:00 to 14:00", "calendar.add", null],
  ],
  "stored on Enio's": [
    ["use enio's email", null, null],
    ["any new mail?", "mail.recent", E],
    ["check my email", "mail.recent", P],
    ["anything from the storage team?", "mail.recent", E],
    ["send ana@example.net a note saying I will be ten minutes late on Friday", null, null],
  ],
  // Requests the possessive rule does not hear: the account is the
  // model's argument, kept or dropped by what the message holds.
  "left to the model": [
    ["has Lena replied to you yet?", "mail.recent", E],
    ["can you find the invoice from Tom in my work inbox?", "mail.recent", W],
    ["any news from the bank?", "mail.recent", P],
  ],
  "named, then your": [
    ["check my work email", "mail.recent", W],
    ["did anyone write to you?", "mail.recent", E],
    ["read the one from Lena", "mail.read", E],
    ["any invoices?", "mail.recent", W],
  ],
};

const SEND = {
  "fresh send": [
    ["send ana@example.net a note saying I will be ten minutes late on Friday", null, null],
    ["yes, send it", null, null],
  ],
  "after reading": [
    ["check my email", "mail.recent", P],
    ["reply to Ana that eight works for me", null, null],
    ["looks good, send it", null, null],
  ],
  "draft only": [
    ["draft an email to tom@northwind.example asking when invoice 4471 is due", null, null],
    ["make it shorter", null, null],
    ["ok send", null, null],
  ],
  "revise twice": [
    ["draft an email to ana@example.net saying I will be ten minutes late on Friday", null, null],
    ["make it shorter", null, null],
    ["add that I will bring the wine", null, null],
    ["send it", null, null],
    ["add a PS that I am sorry", null, null],
  ],
  // The conversation that first showed it: mail read, then a send.
  "after Enio's inbox": [
    ["use enio's email", null, null],
    ["any new mail?", "mail.recent", E],
    ["send ana@example.net a note saying I will be ten minutes late on Friday", null, null],
    ["yes", null, null],
  ],
  // A composing verb in a question about mail: nothing to write.
  "questions with composing verbs": [
    ["check my email", "mail.recent", P],
    ["did Ana write anything about Friday?", null, null],
    ["what did the bank send?", null, null],
  ],
};
const CONVERSATIONS = SET === "send" ? SEND : ACCOUNTS;

// After the accounts exist: the mail tools decide at module load whether
// there is a mailbox to offer them for.
const { buildRegistry } = await import(dist("tools/index.js"));
const { runTurn } = await import(dist("agent.js"));
const outbox = await import(dist("outbox.js"));
const registry = await buildRegistry();
console.log("mail agent tools: " + ["search_email", "read_email", "send_email"].filter((n) => registry.byName.has(n)).join(", "));
const out = [];
for (let rep = 0; rep < REPS; rep++) {
  for (const [name, turns] of Object.entries(CONVERSATIONS)) {
    const sid = store.startSession();
    const history = [];
    for (const [text, op, want] of turns) {
      bridge = [];
      const row = { rep, conversation: name, text, wantOp: op, want, route: null, tools: [], notices: [], reply: "", error: null };
      const t0 = performance.now();
      try {
        const result = await runTurn(text, history, registry, sid, {
          onRoute: (s) => (row.route = s),
          onToolStart: (n, a) => row.tools.push({ name: n, args: a }),
          onToolEnd: (n, o) => {
            const last = [...row.tools].reverse().find((t) => t.name === n && t.output === undefined);
            if (last) last.output = String(o).slice(0, 700);
          },
          onNotice: (n) => row.notices.push(n),
        });
        row.reply = result.reply;
        row.route = row.route ?? result.specialist;
      } catch (err) {
        row.error = String(err?.stack ?? err).slice(0, 600);
      }
      row.seconds = Math.round((performance.now() - t0) / 100) / 10;
      row.bridge = bridge;
      // What the turn left for the person to send, and whether anything
      // went out by itself. The second must never be true.
      row.waiting = outbox.listDrafts({ status: "pending", sessionId: sid }).map((d) => ({ to: d.to, subject: d.subject, body: d.body }));
      row.reachedSend = bridge.some((b) => b.op === "mail.send");
      row.stored = acc.describeAccount ? (acc.conversationAccount(sid) ?? null) : null;
      // Any read of the same kind counts: "what does Ana say?" may search
      // before it opens. Right only when every one was on the account asked.
      const family = op ? op.split(".")[0] + "." : "";
      const hit = op ? bridge.filter((b) => b.op.startsWith(family)) : [];
      row.verdict = !op || want === null ? "recorded" : hit.length === 0 ? "no call" : hit.every((b) => b.email === want) ? "right" : hit.some((b) => b.email === want) ? "mixed" : "wrong";
      out.push(row);
      writeFileSync(outFile, JSON.stringify(out, null, 2));
      const did =
        SET === "send"
          ? `${row.tools.map((t) => t.name).join(",") || "-"} | waiting ${row.waiting.length}${row.reachedSend ? " | SENT BY THE TURN" : ""} | ${row.notices.filter((n) => !/^(?:Searched|Read message|Using|Not found)/.test(n)).map((n) => n.slice(0, 70)).join(" / ") || "-"} | ${row.reply.replace(/\s+/g, " ").slice(0, 90)}`
          : `${bridge.map((b) => `${b.op}@${b.email}`).join(", ") || "-"} | ${row.verdict}`;
      console.log(`[${rep}] ${name} | ${text} -> ${row.route} | ${did} | ${row.seconds}s`);
    }
  }
}
console.log(`\nEvery turn, with its tool calls and reply: ${outFile}`);
const judged = out.filter((r) => r.verdict !== "recorded");
const tally = {};
for (const r of judged) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
console.log(JSON.stringify(tally));
if (SET === "send") {
  const sent = out.filter((r) => r.reachedSend);
  console.log(`turns that reached mail.send: ${sent.length} of ${out.length}`);
  if (sent.length > 0) process.exit(1);
}
process.exit(0);
