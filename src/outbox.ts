import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describeAccount, listAccounts, pinnedAccountNow, scriptAccountById, scriptMailAccount } from "./accounts.js";
import { callScript } from "./appsscript.js";
import { placeNewFile } from "./assets.js";
import { config } from "./config.js";
import { getDb } from "./memory/db.js";
import { logMessage } from "./memory/store.js";
import { recordTurn } from "./memory/traces.js";
import { currentModelId } from "./model-settings.js";

/**
 * The outbox: Enio writes a message, a person sends it.
 *
 * `send_email` used to reach the mail transport. What stood between "send
 * Ana a note" and a message that cannot be recalled was the model's own
 * judgement about whether to show it first, and "showing" was prose in a
 * reply that the harness then had to tell apart from an invented inbox
 * email by its shape. Three versions of that check and two reviews (42
 * findings) did not close it, and after a dry run the model said "sent".
 *
 * So the tool no longer sends. It writes a row here and the turn ends. The
 * only code that talks to SMTP or a connected account is `sendDraft`,
 * below, and nothing reaches it from a tool: an authenticated route, a
 * terminal command, a button. What the person reads is the stored row,
 * edits are made to the stored row, and the stored row is what goes.
 *
 * ENIO_EMAIL_SEND therefore means "the Send button works", not "the
 * model's call sends". With it off a draft is written, shown and kept, and
 * sending answers that it is switched off and leaves the draft waiting.
 */

/* ------------------------------------------------------------ addresses */

/**
 * The addresses in a To or Cc value, one by one.
 *
 * The value used to be handed on as the model wrote it, and the allow-list
 * was asked one question of the whole string: does it end with the rule.
 * "x@evil.example, ana@corp.com" ends with "@corp.com", both transports
 * take a comma-separated list, and both people got the mail. Cc was not
 * asked at all. So a value is taken apart first, and everything after
 * this -- the allow-list, the stored draft, the send -- works on the list
 * of bare addresses.
 *
 * A part is an address, or a name followed by one in angle brackets;
 * commas and semicolons separate, except inside quotes or brackets
 * ("Costa, Ana" <ana@corp.com>). Anything else is refused whole, with the
 * part that would not parse: guessing at a recipient is the one mistake a
 * send cannot take back.
 */
export function addressesIn(value: string): { ok: true; addresses: string[] } | { ok: false; bad: string } {
  const parts: string[] = [];
  let part = "";
  let quoted = false;
  let angled = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angled = true;
    else if (ch === ">" && !quoted) angled = false;
    if ((ch === "," || ch === ";") && !quoted && !angled) {
      parts.push(part);
      part = "";
    } else part += ch;
  }
  parts.push(part);

  const one = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\.]+(?:\.[^\s@<>,;:"()[\]\\.]+)+$/;
  const addresses: string[] = [];
  for (const raw of parts) {
    const text = raw.trim();
    if (!text) continue;
    const named = /^(?:"[^"]*"|[^<>"]*?)\s*<([^<>]+)>$/.exec(text);
    const address = (named ? named[1]! : text).trim().toLowerCase();
    if (!one.test(address)) return { ok: false, bad: text };
    if (!addresses.includes(address)) addresses.push(address);
  }
  return { ok: true, addresses };
}

/** One parsed address against the allow-list. A rule that starts with "@"
 *  permits everyone at that domain; any other rule is one address. */
export function recipientAllowed(address: string, rules: string[] = config.emailAllowedTo): boolean {
  if (rules.length === 0) return true;
  return rules.some((allowed) => {
    const rule = allowed.toLowerCase().trim();
    return rule.startsWith("@") ? address.endsWith(rule) : address === rule;
  });
}

export const smtpConfigured = () => Boolean(config.smtpHost && config.emailFrom);

/** A message's fields, checked: every address parsed and permitted, one
 *  line of subject. The same check when a draft is written, when a person
 *  edits it, and again when it is sent. */
export function checkMessage(input: { to: string; cc?: string; subject: string }):
  | { ok: true; to: string[]; cc: string[]; subject: string }
  | { ok: false; reason: string } {
  const asked = input.to.trim();
  const to = addressesIn(asked);
  if (!to.ok) return { ok: false, reason: `"${to.bad}" is not an email address.` };
  if (to.addresses.length === 0) return { ok: false, reason: `"${asked}" is not an email address.` };
  const cc = addressesIn(input.cc ?? "");
  if (!cc.ok) return { ok: false, reason: `"${cc.bad}" in the cc is not an email address.` };
  // One line: a line break in a subject becomes more header lines in the
  // message a person reads, and they were never headers.
  const subject = input.subject.replace(/[\r\n]+/g, " ").trim();
  if (!subject) return { ok: false, reason: "A message needs a subject." };
  // Every address, in both fields: a list is as open as its least checked
  // member.
  const barred = [...to.addresses, ...cc.addresses].filter((address) => !recipientAllowed(address));
  if (barred.length > 0) {
    return {
      ok: false,
      reason:
        `Refused: ${barred.join(", ")} ${barred.length === 1 ? "is" : "are"} not in the allowed recipient list ` +
        `(${config.emailAllowedTo.join(", ")}). Change ENIO_EMAIL_ALLOWED_TO to permit it.`,
    };
  }
  return { ok: true, to: to.addresses, cc: cc.addresses, subject };
}

/* ---------------------------------------------------------------- drafts */

export type DraftStatus = "pending" | "sending" | "sent" | "discarded" | "replaced";

/** Where a draft came from, for the person who finds it waiting: a
 *  conversation, a step of an automation, a watch. Set by the harness. */
export interface DraftOrigin {
  kind: "chat" | "automation" | "terminal" | "api";
  /** What separates one source from another inside a session: a step's
   *  id in an automation run. A new draft replaces a waiting one only
   *  from the same place, to the same people. */
  key?: string;
  /** The request it was written for, quoted. */
  request?: string;
}

export interface Draft {
  id: string;
  sessionId: string | null;
  origin: DraftOrigin | null;
  /** The connected account it goes from; null means SMTP. */
  accountId: string | null;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  /** What Enio wrote, kept as written: "edited" is then a fact, not a guess. */
  proposed: { to: string[]; cc: string[]; subject: string; body: string };
  status: DraftStatus;
  /** Goes up with every change. A send or an edit names the revision it
   *  saw, so a card left open cannot send text that changed under it. */
  revision: number;
  result: string | null;
  lastError: string | null;
  file: string | null;
  createdAt: number;
  decidedAt: number | null;
}

interface Row {
  id: string;
  session_id: string | null;
  origin: string | null;
  account_id: string | null;
  from_addr: string;
  to_addrs: string;
  cc_addrs: string;
  subject: string;
  body: string;
  proposed: string;
  status: DraftStatus;
  revision: number;
  result: string | null;
  last_error: string | null;
  file: string | null;
  created_at: number;
  decided_at: number | null;
}

const hydrate = (r: Row): Draft => ({
  id: r.id,
  sessionId: r.session_id,
  origin: r.origin ? (JSON.parse(r.origin) as DraftOrigin) : null,
  accountId: r.account_id,
  from: r.from_addr,
  to: JSON.parse(r.to_addrs) as string[],
  cc: JSON.parse(r.cc_addrs) as string[],
  subject: r.subject,
  body: r.body,
  proposed: JSON.parse(r.proposed) as Draft["proposed"],
  status: r.status,
  revision: r.revision,
  result: r.result,
  lastError: r.last_error,
  file: r.file,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

/** The message as a person reads it, and as the .eml file holds it. */
export function renderDraft(d: Pick<Draft, "from" | "to" | "cc" | "subject" | "body">): string {
  return (
    `From: ${d.from}\nTo: ${d.to.join(", ")}\n` +
    (d.cc.length > 0 ? `Cc: ${d.cc.join(", ")}\n` : "") +
    `Subject: ${d.subject}\n\n${d.body}`
  );
}

/**
 * What a Cc means on the account this draft goes from, when it means
 * something other than "they get a copy". Empty otherwise.
 */
export function ccNote(d: Pick<Draft, "accountId" | "cc">): string {
  if (!d.accountId || d.cc.length === 0) return "";
  return (
    `This account cannot cc: ${d.cc.join(", ")} will not receive it. ` +
    `A line naming ${d.cc.length === 1 ? "that address" : "those addresses"} is added at the end of the message when it is sent. To reach them, put them in To.`
  );
}

export const wasEdited = (d: Draft): boolean =>
  JSON.stringify({ to: d.to, cc: d.cc, subject: d.subject, body: d.body }) !== JSON.stringify(d.proposed);

/**
 * Write a message into the outbox. Nothing is sent.
 *
 * The account is the one a send would use: Enio's own first, as before,
 * or the one a step is set to. With none, SMTP when it is configured.
 * With neither there is nothing a Send could do, and the tool says so
 * instead of storing a draft that can never leave.
 */
export function writeDraft(input: { to: string; cc?: string; subject: string; body: string }):
  | { ok: true; draft: Draft }
  | { ok: false; reason: string } {
  const checked = checkMessage(input);
  if (!checked.ok) return checked;
  const account = scriptMailAccount("send");
  if (!account && pinnedAccountNow()) {
    return { ok: false, reason: "This step is set to an account that cannot send mail, so nothing was written. Choose another account for the step." };
  }
  if (!account && !smtpConfigured()) return { ok: false, reason: "No connected account can send mail." };

  const draft: Draft = {
    id: randomUUID(),
    sessionId: null,
    origin: null,
    accountId: account?.id ?? null,
    from: account?.email ?? config.emailFrom,
    to: checked.to,
    cc: checked.cc,
    subject: checked.subject,
    body: input.body,
    proposed: { to: checked.to, cc: checked.cc, subject: checked.subject, body: input.body },
    status: "pending",
    revision: 1,
    result: null,
    lastError: null,
    file: null,
    createdAt: Date.now(),
    decidedAt: null,
  };
  // The draft is something Enio made, so it is an asset of this turn, and
  // a file a person can open with no app running.
  try {
    draft.file = placeNewFile(`draft-${draft.createdAt}.eml`);
    writeFileSync(draft.file, `${renderDraft(draft)}\n`, "utf8");
  } catch {
    draft.file = null;
  }
  getDb()
    .prepare(
      `INSERT INTO outbox (id, session_id, origin, account_id, from_addr, to_addrs, cc_addrs, subject, body, proposed, status, revision, file, created_at)
       VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)`,
    )
    .run(
      draft.id,
      draft.accountId,
      draft.from,
      JSON.stringify(draft.to),
      JSON.stringify(draft.cc),
      draft.subject,
      draft.body,
      JSON.stringify(draft.proposed),
      draft.file,
      draft.createdAt,
    );
  return { ok: true, draft };
}

/**
 * Say where a draft came from, and let it take the place of an earlier
 * one. Called by the turn loop, which knows the conversation; the tool
 * that wrote the row does not.
 *
 * Replaced: a draft still waiting from the same place (this conversation,
 * or this step of this run) to the same people. That is "make it shorter"
 * answered by writing the message again. Never one from another step or
 * to anyone else: two steps of a run that both write to Ana are two
 * messages.
 */
export function placeDraft(id: string, sessionId: string, origin: DraftOrigin): { replaced: string | null } {
  const db = getDb();
  const draft = getDraft(id);
  if (!draft) return { replaced: null };
  const same = (
    db.prepare(`SELECT * FROM outbox WHERE session_id = ? AND status = 'pending' AND id != ?`).all(sessionId, id) as Row[]
  )
    .map(hydrate)
    .filter(
      (d) =>
        (d.origin?.key ?? "") === (origin.key ?? "") &&
        d.origin?.kind === origin.kind &&
        [...d.to].sort().join(",") === [...draft.to].sort().join(","),
    );
  const at = Date.now();
  for (const old of same) {
    db.prepare(`UPDATE outbox SET status = 'replaced', decided_at = ?, result = ? WHERE id = ? AND status = 'pending'`).run(at, `Replaced by ${id}.`, old.id);
  }
  db.prepare(`UPDATE outbox SET session_id = ?, origin = ? WHERE id = ?`).run(sessionId, JSON.stringify(origin), id);
  return { replaced: same[0]?.id ?? null };
}

export function getDraft(id: string): Draft | null {
  const row = getDb().prepare(`SELECT * FROM outbox WHERE id = ?`).get(id) as Row | undefined;
  return row ? hydrate(row) : null;
}

/** A send that never came back: the process ended in the middle of one.
 *  By age, not at start-up: the scheduler, the server and a terminal share
 *  this table, and one starting while another is mid-send must not call
 *  that send lost. */
const STALE_SEND_MS = 5 * 60_000;
/** The longest a send may stay open. Well under the stale age, so a row
 *  released as stale is one whose process is gone, not one still talking:
 *  with the transports' own limits (five and ten minutes) a slow send was
 *  released, sent again by the person, and then overwritten by the first
 *  one's late answer. */
const SEND_TIMEOUT_MS = 90_000;
function releaseStaleSends(): void {
  getDb()
    .prepare(
      `UPDATE outbox SET status = 'pending', revision = revision + 1,
              last_error = 'A send was started and never finished. It may or may not have gone: check the Sent folder before sending again.'
       WHERE status = 'sending' AND decided_at IS NOT NULL AND decided_at < ?`,
    )
    .run(Date.now() - STALE_SEND_MS);
}

export function listDrafts(filter: { status?: DraftStatus; sessionId?: string } = {}): Draft[] {
  releaseStaleSends();
  const where: string[] = [];
  const args: string[] = [];
  if (filter.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  if (filter.sessionId) {
    where.push("session_id = ?");
    args.push(filter.sessionId);
  }
  const rows = getDb()
    .prepare(`SELECT * FROM outbox ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 200`)
    .all(...args) as Row[];
  return rows.map(hydrate);
}

export type OutboxFailure = { ok: false; code: "not_found" | "not_waiting" | "changed" | "invalid" | "sending_off" | "failed"; message: string };

/** A person's edit, written to the row that will be sent. */
export function updateDraft(
  id: string,
  revision: number,
  patch: { to?: string; cc?: string; subject?: string; body?: string },
): { ok: true; draft: Draft } | OutboxFailure {
  const draft = getDraft(id);
  if (!draft) return { ok: false, code: "not_found", message: "No such message." };
  if (draft.status !== "pending") return { ok: false, code: "not_waiting", message: `This message was already ${draft.status}.` };
  if (draft.revision !== revision) return { ok: false, code: "changed", message: "This message changed since it was opened. Look at it again." };
  const checked = checkMessage({
    to: patch.to ?? draft.to.join(", "),
    cc: patch.cc ?? draft.cc.join(", "),
    subject: patch.subject ?? draft.subject,
  });
  if (!checked.ok) return { ok: false, code: "invalid", message: checked.reason };
  const done = getDb()
    .prepare(
      `UPDATE outbox SET to_addrs = ?, cc_addrs = ?, subject = ?, body = ?, revision = revision + 1, last_error = NULL
       WHERE id = ? AND status = 'pending' AND revision = ?`,
    )
    .run(JSON.stringify(checked.to), JSON.stringify(checked.cc), checked.subject, patch.body ?? draft.body, id, revision);
  if (done.changes !== 1) return { ok: false, code: "changed", message: "This message changed since it was opened. Look at it again." };
  return { ok: true, draft: getDraft(id)! };
}

export function discardDraft(id: string): { ok: true; draft: Draft } | OutboxFailure {
  const draft = getDraft(id);
  if (!draft) return { ok: false, code: "not_found", message: "No such message." };
  const done = getDb()
    .prepare(`UPDATE outbox SET status = 'discarded', decided_at = ? WHERE id = ? AND status = 'pending'`)
    .run(Date.now(), id);
  if (done.changes !== 1) return { ok: false, code: "not_waiting", message: `This message was already ${draft.status}.` };
  return { ok: true, draft: getDraft(id)! };
}

/**
 * Send a draft. The one place mail leaves from.
 *
 * Claimed first, in one statement: of two Sends at once, one finds the
 * row no longer waiting and does nothing. Then everything that was true
 * when it was written is asked again, because any of it may have changed
 * while it waited: whether sending is on, the allow-list (a person may
 * have edited the addresses), the account and its grant.
 *
 * A failure puts the draft back to waiting, with the person's edits in
 * it, and says what happened. Whether a failed send may have gone anyway
 * is not something either transport can always tell, so the message says
 * so when it cannot.
 */
export async function sendDraft(id: string, revision?: number): Promise<{ ok: true; draft: Draft } | OutboxFailure> {
  releaseStaleSends();
  const db = getDb();
  const before = getDraft(id);
  if (!before) return { ok: false, code: "not_found", message: "No such message." };
  if (before.status !== "pending") return { ok: false, code: "not_waiting", message: `This message was already ${before.status}.` };
  if (revision !== undefined && before.revision !== revision) {
    return { ok: false, code: "changed", message: "This message changed since it was opened. Look at it again." };
  }
  if (!config.emailSend) {
    return {
      ok: false,
      code: "sending_off",
      message: "Sending is switched off on this machine, so the message is still waiting. Set ENIO_EMAIL_SEND=1 and restart Enio to send.",
    };
  }
  // The claim is this send's own: both ways it can end are written only
  // to the row as this claim left it. A send that outlived its claim (the
  // row was released, and then sent again, edited or discarded) must not
  // write its late answer over what the row has become.
  const claim = Date.now();
  const claimed = db
    .prepare(`UPDATE outbox SET status = 'sending', decided_at = ? WHERE id = ? AND status = 'pending' AND revision = ?`)
    .run(claim, id, before.revision);
  if (claimed.changes !== 1) return { ok: false, code: "not_waiting", message: "This message is already being sent." };
  const mine = `WHERE id = ? AND status = 'sending' AND decided_at = ? AND revision = ?`;

  const back = (message: string, code: OutboxFailure["code"] = "failed"): OutboxFailure => {
    db.prepare(`UPDATE outbox SET status = 'pending', decided_at = NULL, revision = revision + 1, last_error = ? ${mine}`).run(message, id, claim, before.revision);
    return { ok: false, code, message };
  };

  const checked = checkMessage({ to: before.to.join(", "), cc: before.cc.join(", "), subject: before.subject });
  if (!checked.ok) return back(checked.reason, "invalid");

  let outcome: string;
  try {
    if (before.accountId) {
      const account = scriptAccountById(before.accountId, "mail.send");
      if (!account) {
        return back("The account this message was to be sent from is no longer connected, or can no longer send. Nothing was sent.", "invalid");
      }
      // The bridge sends to To only; a cc is noted in the body, and said.
      const result = await callScript(
        account.url,
        account.secret,
        "mail.send",
        {
          to: checked.to.join(", "),
          subject: checked.subject,
          body: checked.cc.length > 0 ? `${before.body}\n\n(cc requested: ${checked.cc.join(", ")})` : before.body,
        },
        SEND_TIMEOUT_MS,
      );
      if (!result.ok) {
        const unsure = /could not reach|timed out|returned 5\d\d/i.test(result.error);
        return back(`Could not send: ${result.error}${unsure ? " It may or may not have gone: check the Sent folder before sending again." : ""}`);
      }
      outcome =
        `Sent to ${checked.to.join(", ")} from ${account.email}.` +
        (checked.cc.length > 0 ? ` The cc (${checked.cc.join(", ")}) was NOT sent to: this account's send has no cc, and the addresses are noted at the end of the message.` : "");
    } else {
      if (!smtpConfigured()) return back("No way to send is configured any more. Nothing was sent.", "invalid");
      const nodemailer = await import("nodemailer");
      const transport = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        // Port 465 is implicit TLS; 587 and 25 start plaintext and upgrade
        // with STARTTLS, which nodemailer does automatically.
        secure: config.smtpPort === 465,
        auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
        connectionTimeout: 30_000,
        greetingTimeout: 30_000,
        socketTimeout: SEND_TIMEOUT_MS,
      });
      const info = await transport.sendMail({
        from: config.emailFrom,
        to: checked.to.join(", "),
        cc: checked.cc.length > 0 ? checked.cc.join(", ") : undefined,
        subject: checked.subject,
        text: before.body,
      });
      outcome = `Sent to ${checked.to.join(", ")} — message id ${info.messageId}`;
    }
  } catch (err) {
    return back(`Could not send: ${(err as Error).message}. It may or may not have gone: check the Sent folder before sending again.`);
  }
  const done = db.prepare(`UPDATE outbox SET status = 'sent', decided_at = ?, result = ?, last_error = NULL ${mine}`).run(Date.now(), outcome, id, claim, before.revision);
  if (done.changes !== 1) {
    // It went, and the row is no longer this send's to mark. Nothing is
    // written over it; the person is told what is known.
    return {
      ok: false,
      code: "changed",
      message: `${outcome} Its record was released while it was going and has changed since, so it is not marked as sent: check the Sent folder before sending it again.`,
    };
  }
  return { ok: true, draft: getDraft(id)! };
}

/** Whose account a draft goes from, in the window's words. */
export function draftSender(d: Draft): string {
  const account = d.accountId ? listAccounts().find((a) => a.id === d.accountId) : null;
  return account ? describeAccount(account) : d.from;
}

/* ------------------------------------------------- what a client is shown */

/** A draft as a window or a terminal shows it. */
export function draftView(d: Draft) {
  return {
    id: d.id,
    revision: d.revision,
    status: d.status,
    sessionId: d.sessionId,
    origin: d.origin,
    from: d.from,
    sender: draftSender(d),
    to: d.to,
    cc: d.cc,
    subject: d.subject,
    body: d.body,
    edited: wasEdited(d),
    ccNote: ccNote(d),
    result: d.result,
    lastError: d.lastError,
    file: d.file,
    createdAt: d.createdAt,
    decidedAt: d.decidedAt,
    // Whether Send can do anything, so a button can say why it cannot
    // before it is pressed instead of after.
    sendingOn: config.emailSend,
  };
}

/** A draft by its id, or by the start of it: an id is thirty-six
 *  characters and a terminal is typed into. Only when exactly one waiting
 *  draft starts that way -- a guess here is a message to the wrong person. */
export function findDraft(idOrStart: string): Draft | null {
  const wanted = idOrStart.trim().toLowerCase();
  if (!wanted) return null;
  const exact = getDraft(wanted);
  if (exact) return exact;
  if (wanted.length < 4) return null;
  const starts = listDrafts({ status: "pending" }).filter((d) => d.id.startsWith(wanted));
  return starts.length === 1 ? starts[0]! : null;
}

/**
 * What a person did with a draft, said in the conversation it came from.
 *
 * Assembled here from the stored row and the transport's own answer, never
 * by a model: the first version of a plan run left its outcome on another
 * surface and the thread never learned what happened, and a model asked to
 * report a send is the thing that said "sent" after a dry run. Recorded as
 * a turn so a restored conversation shows it, and so the next turn's model
 * reads that the message went (or did not) instead of guessing.
 *
 * A failed send says nothing here. The draft is still waiting, with the
 * reason on it, and the thread would otherwise collect one line per try.
 */
export function draftOutcome(d: Draft): string {
  const whom = d.to.join(", ");
  if (d.status === "sent") {
    return (
      `You sent the message to ${whom}: "${d.subject}".` +
      (wasEdited(d) ? " It went as you changed it, not as I first wrote it." : "") +
      (d.result && /was NOT sent to/.test(d.result) ? ` ${d.result.slice(d.result.indexOf("The cc"))}` : "")
    );
  }
  if (d.status === "discarded") return `You discarded the message to ${whom}: "${d.subject}". Nothing was sent.`;
  return "";
}

export function recordDraftOutcome(d: Draft): string {
  const reply = draftOutcome(d);
  if (!reply || !d.sessionId) return reply;
  try {
    recordTurn({
      sessionId: d.sessionId,
      question: d.status === "sent" ? "(sent the message)" : "(discarded the message)",
      reply,
      specialist: "mail",
      systemPrompt: "(harness: outbox)",
      memoryBlock: "",
      startedAt: Date.now(),
      durationMs: 0,
      iterations: 0,
      model: currentModelId(),
      steps: [
        {
          seq: 0,
          kind: "harness",
          name: "outbox",
          args: JSON.stringify({ id: d.id, status: d.status, edited: wasEdited(d) }),
          output: d.result ?? reply,
          error: null,
          durationMs: 0,
        },
      ],
    });
  } catch {
    /* Tracing must never cost the outcome its place in the thread. */
  }
  logMessage(d.sessionId, "assistant", reply);
  return reply;
}
