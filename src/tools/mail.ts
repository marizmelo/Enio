import { config } from "../config.js";
import {
  agentOnlyMailAccount,
  anyMailReadAccount,
  askedOwnerThisTurn,
  findAccountByName,
  listAccounts,
  noteMailRead,
  noteNameRefused,
  pinnedAccountNow,
  ownerWord,
  personNamed,
  scriptAccountById,
  scriptMailAccount,
  speakerRelative,
  type PickedAccount,
} from "../accounts.js";

/**
 * Which mailbox each listed message came from, so opening one does not
 * depend on where the turn's account points by then. A search of Enio's
 * inbox followed by "read the second one" has no "your" in it, and the id
 * was sent to whatever account the conversation meant: a message that is
 * not there. Bounded, in listing order; an id that has fallen out is read
 * the way it always was.
 */
const listedIn = new Map<string, string>();
const LISTED_AT_MOST = 2000;
function noteListed(messageId: string, accountId: string): void {
  if (!messageId) return;
  listedIn.delete(messageId);
  listedIn.set(messageId, accountId);
  if (listedIn.size > LISTED_AT_MOST) listedIn.delete(listedIn.keys().next().value!);
}

/**
 * Which account a mail read uses, and what to say when it is not the one
 * that was asked for.
 *
 * Two voices can ask. The person's, read by the harness from their message
 * (askedOwnerThisTurn), is the one the picker already honoured. The model's
 * is the `account` argument, and it is trusted only for what has one
 * meaning whoever says it: a label, an address, "enio's", "the user's". A
 * first- or second-person word there is dropped (speakerRelative) -- the
 * same word points at either account depending on whose voice the model
 * wrote it in. And a name counts only with the person's words this turn
 * behind it (personNamed): the model also fills the argument in from its
 * own prompt and from its last call.
 *
 * `forId` is a message being opened. Its own mailbox comes before
 * anything but a named account, and an argument that names nothing is let
 * go: the id already says which message is wanted.
 */
function mailReadAccount(
  argument: unknown,
  forId?: string,
): { account: PickedAccount | null; preface: string; refusal: string | null } {
  const written = typeof argument === "string" && !speakerRelative(argument) ? argument.trim() : "";
  // The model's choice needs the person's words behind it (personNamed):
  // it also fills this in from its own prompt and from its last call.
  const wanted = written ? findAccountByName(written) : null;
  const arg = written && personNamed(written, wanted) ? written : "";
  const named = arg ? wanted : null;
  // A label that matches nothing is refused with the list, for a search:
  // searching some other mailbox instead would answer a question nobody
  // asked. An owner word with no such account ("user's" when only Enio's
  // own is connected) is a fact to state, then search what exists --
  // refusing it left the model narrating "Searching…" over an error.
  if (arg && !named && !ownerWord(arg) && forId === undefined) {
    noteNameRefused();
    return {
      account: null,
      preface: "",
      refusal: `No connected account matches "${arg}". Connected: ${listAccounts().map((a) => a.label ?? a.email).join(", ") || "none"}.`,
    };
  }
  if (named) {
    const account = scriptAccountById(named.id, "mail.read");
    return account
      ? { account, preface: "", refusal: null }
      : { account: null, preface: "", refusal: `${named.label ?? named.email} is connected without the read-mail grant.` };
  }
  const listed = forId !== undefined ? listedIn.get(forId) : undefined;
  // A step set to one account opens what THAT account listed. An id
  // listed by another step of the run, from another mailbox, is not its
  // to open.
  const pinned = pinnedAccountNow();
  if (pinned && listed && listed !== pinned) {
    return { account: null, preface: "", refusal: "That message was listed from another account, and this step is set to one. Nothing was opened: search this step's own account first." };
  }
  const fromListing = listed ? scriptAccountById(listed, "mail.read") : null;
  if (fromListing) return { account: fromListing, preface: "", refusal: null };

  let account = scriptMailAccount("read");
  // And reads from it or from nothing: with no account here, what follows
  // is the IMAP mailbox, or a message about accounts nobody is asking about.
  if (pinned && !account) {
    return { account: null, preface: "", refusal: "This step is set to an account that cannot read mail, so nothing was read. Choose another account for the step." };
  }
  const person = askedOwnerThisTurn();
  // The person asked for their own and what would be read is Enio's: the
  // conversation was left on it and nothing of theirs can read mail. Not
  // read as theirs -- the rule of the fallback, reached another way. Only
  // their own asking does this; a model's "user's" is stated, below.
  if (person === "user" && account?.owner === "agent") account = null;
  const asked = person ?? (arg ? ownerWord(arg) : null);
  // Said only when something else stood in for what was asked -- which
  // includes an account the model asked for and did not get. The result
  // otherwise gives an address and no owner, and the model goes on to
  // describe the mailbox it asked for: Enio's inbox as "you have one new
  // message". Whose it is, in the words the ownership check listens for.
  const preface =
    asked && account && account.owner !== asked
      ? `${asked === "user" ? "No account of yours is connected" : "I have no account of my own that can read mail"} — this is ${account.spoken}.\n\n`
      : written && !arg && account && wanted?.id !== account.id
        ? `This is ${account.spoken}.\n\n`
        : "";
  return { account, preface, refusal: null };
}

/** The honest answer when only Enio's own account can read mail: not the
 *  person's inbox, so not read as if it were. Named so the person can ask
 *  for it on purpose. */
const onlyAgentMail = (agent: { spoken: string; label?: string; email: string }) =>
  `No account of yours is connected. The only connected account is ${agent.spoken}, and that is my mail, not yours. ` +
  `Connect your account in [Connections](enio://panel/accounts/add), or ask for Enio's inbox by name (for example "check ${agent.label ?? agent.email}").`;
import { callScript } from "../appsscript.js";
import type { BuiltinTool } from "../types.js";

/**
 * Reading mail over IMAP. Strictly read-only.
 *
 * IMAP rather than POP3 on purpose. POP3 is a single-device protocol that
 * downloads and traditionally deletes: no folders, no flags, no server-side
 * search. Pointing an agent at it could pull mail off the server so your phone
 * never sees it again. IMAP leaves everything in place and can search on the
 * server, so "find the thread about the invoice" is one query rather than a
 * download of the whole mailbox.
 *
 * Nothing here mutates. No delete, no move, and specifically no marking read —
 * an agent silently marking your inbox read is a bad afternoon with no undo.
 * Every fetch is explicitly non-destructive.
 */

export const mailConfigured = () =>
  Boolean(config.imapHost && config.imapUser && config.imapPass);

function folderAllowed(name: string): boolean {
  if (config.imapFolders.length === 0) return true;
  return config.imapFolders.some((f) => f.toLowerCase() === name.toLowerCase());
}

interface Connection {
  client: any;
  close(): Promise<void>;
}

async function connect(folder: string): Promise<Connection> {
  if (!folderAllowed(folder)) {
    throw new Error(
      `Folder "${folder}" is not in the allowed list (${config.imapFolders.join(", ")}).`,
    );
  }

  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapPort === 993,
    auth: { user: config.imapUser, pass: config.imapPass },
    // imapflow logs every protocol exchange at info level otherwise, which
    // would bury the conversation in IMAP chatter.
    logger: false,
  });

  await client.connect();
  // readOnly opens the mailbox in EXAMINE rather than SELECT, so the server
  // itself refuses any change — including the implicit \Seen flag that a
  // normal fetch would set.
  const lock = await client.getMailboxLock(folder, { readOnly: true });

  return {
    client,
    async close() {
      lock.release();
      await client.logout().catch(() => {});
    },
  };
}

const formatDate = (d: unknown) =>
  d instanceof Date ? d.toISOString().slice(0, 16).replace("T", " ") : "?";

const addressOf = (a: any): string =>
  (a?.value ?? []).map((v: any) => v.name || v.address || "").filter(Boolean).join(", ") ||
  a?.text ||
  "unknown";

const searchTool: BuiltinTool = {
  name: "search_email",
  description:
    "Search the mailbox and get back a list of matching messages: id, sender, subject, date and a short snippet. Use read_email afterwards to read one in full.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Words to look for in the subject or body. Leave empty to list the most recent messages.",
      },
      from: { type: "string", description: "Optional. Filter by sender address or name." },
      days: {
        type: "number",
        description: "Optional. Only messages from the last N days. Default 30.",
      },
      folder: { type: "string", description: `Optional. Default ${config.imapFolders[0] ?? "INBOX"}.` },
      limit: { type: "number", description: "How many to return (1-25). Default 10." },
      account: {
        type: "string",
        description:
          "Which connected account to search, by its label or address, when the user named one (\"work\", \"enio's\"). Omit to use the conversation's account.",
      },
    },
    required: [],
  },
  async run(args) {
    const folder = String(args.folder ?? config.imapFolders[0] ?? "INBOX");
    const limit = Math.min(25, Math.max(1, Number(args.limit ?? 10) || 10));
    const days = Math.max(1, Number(args.days ?? 30) || 30);

    // A connected account outranks IMAP: it is the setup the user did most
    // recently and deliberately. The credential is attached HERE, harness
    // side -- the model asked to search, and never sees a URL or secret.
    const { account, preface, refusal } = mailReadAccount(args.account);
    if (refusal) return refusal;
    // Every path that found no account of the person's, including an owner
    // word like "user's" that matched nothing: say what exists, read nothing.
    if (!account) {
      const agentOnly = agentOnlyMailAccount();
      if (agentOnly) return { text: onlyAgentMail(agentOnly), notice: `No account of yours is connected; Enio's own was not read. Connect yours in [Connections](enio://panel/accounts/add).` };
    }
    if (account) {
      noteMailRead(account.owner);
      const parts: string[] = [];
      if (args.query) parts.push(String(args.query));
      if (args.from) parts.push(`from:${String(args.from)}`);
      parts.push(`newer_than:${days}d`);
      const result = await callScript(account.url, account.secret, "mail.recent", {
        query: parts.join(" ") || "in:inbox",
        max: limit,
      });
      if (!result.ok) return `Mail search failed: ${result.error}`;
      const rows = (result.result as Array<Record<string, string>>) ?? [];
      for (const m of rows) noteListed(String(m.id ?? ""), account.id);
      if (rows.length === 0) {
        return { text: `${preface}No messages matched in ${account.email}.`, notice: `Searched ${account.described} (${parts.join(" ")}): nothing matched.` };
      }
      // The connected account is Gmail, whose message ids are addressable
      // in the browser. The link rides with each row so "open this in my
      // browser" is a fact the model can quote, not one it has to invent.
      const lines = rows.map(
        (m) =>
          `[${m.id}] ${String(m.date ?? "").slice(0, 10)}  ${m.from ?? "unknown"}\n` +
          `      ${m.subject || "(no subject)"}\n` +
          `      ${String(m.snippet ?? "").replace(/\s+/g, " ").slice(0, 140)}\n` +
          `      open: ${gmailLink(String(m.id ?? ""))}`,
      );
      // Which inbox was read is a fact the person must see whether or not
      // the model repeats it: a search that returned one old message from
      // a secondary account read as "my inbox has one email".
      return {
        text:
          `${preface}${rows.length} matches in ${account.email}:\n\n${lines.join("\n\n")}\n\n` +
          `Read one with read_email using its [id].`,
        notice: `Searched ${account.described} (${parts.join(" ")}): ${rows.length} message${rows.length === 1 ? "" : "s"}.`,
      };
    }

    let connection: Connection | null = null;
    try {
      connection = await connect(folder);

      // Built as a server-side query so the mailbox is never downloaded.
      const criteria: Record<string, unknown> = {
        since: new Date(Date.now() - days * 86_400_000),
      };
      if (args.query) criteria.or = [{ subject: String(args.query) }, { body: String(args.query) }];
      if (args.from) criteria.from = String(args.from);

      const uids: number[] = await connection.client.search(criteria, { uid: true });
      if (!uids || uids.length === 0) return `No messages matched in ${folder}.`;

      // Newest first, and only the tail is fetched.
      const wanted = uids.slice(-limit).reverse();
      const rows: string[] = [];

      for await (const message of connection.client.fetch(
        wanted,
        { uid: true, envelope: true, bodyStructure: true, size: true },
        { uid: true },
      )) {
        const envelope = message.envelope ?? {};
        const from = (envelope.from ?? [])
          .map((a: any) => a.name || a.address)
          .filter(Boolean)
          .join(", ");
        rows.push(
          `[${message.uid}] ${formatDate(envelope.date)}  ${from || "unknown"}\n` +
            `      ${envelope.subject || "(no subject)"}`,
        );
      }

      return (
        `${rows.length} of ${uids.length} matches in ${folder}:\n\n${rows.join("\n\n")}\n\n` +
        `Read one with read_email using its [id].`
      );
    } catch (err) {
      return `Mail search failed: ${(err as Error).message}`;
    } finally {
      await connection?.close();
    }
  },
};

const readTool: BuiltinTool = {
  name: "read_email",
  description:
    "Read one message in full by the id from search_email. Returns the headers and the body as plain text.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The [id] shown by search_email." },
      folder: { type: "string", description: `Optional. Default ${config.imapFolders[0] ?? "INBOX"}.` },
      account: { type: "string", description: "The connected account the id came from, when the user named one. Omit to use the conversation's account." },
    },
    required: ["id"],
  },
  async run(args) {
    const { account, refusal } = mailReadAccount(args.account, String(args.id ?? ""));
    if (refusal) return refusal;
    if (!account) {
      const agentOnly = agentOnlyMailAccount();
      if (agentOnly) return onlyAgentMail(agentOnly);
    }
    if (account) {
      noteMailRead(account.owner);
      const result = await callScript(account.url, account.secret, "mail.read", {
        id: String(args.id ?? ""),
      });
      if (!result.ok) return `Could not read message: ${result.error}`;
      const m = result.result as Record<string, string>;
      const body = String(m.body ?? "");
      return {
        text: [
          `From:    ${m.from ?? "unknown"}`,
          `To:      ${m.to ?? ""}`,
          `Date:    ${String(m.date ?? "").slice(0, 16).replace("T", " ")}`,
          `Subject: ${m.subject ?? "(no subject)"}`,
          `Open:    ${gmailLink(String(args.id ?? ""))}`,
          "",
          body.length > 12_000 ? body.slice(0, 12_000) + "\n[...truncated]" : body || "(empty message)",
        ].join("\n"),
        notice: `Read message ${String(args.id ?? "")} from ${account.described}.`,
      };
    }

    const uid = Number(args.id);
    if (!Number.isFinite(uid)) return "Error: id must be the number shown by search_email.";
    const folder = String(args.folder ?? config.imapFolders[0] ?? "INBOX");

    let connection: Connection | null = null;
    try {
      connection = await connect(folder);
      const message = await connection.client.fetchOne(
        String(uid),
        { uid: true, source: true },
        { uid: true },
      );
      if (!message?.source) return `No message with id ${uid} in ${folder}.`;

      const { simpleParser } = await import("mailparser");
      const parsed = await simpleParser(message.source);

      // Prefer the text part; fall back to stripping the HTML one, since
      // plenty of senders ship HTML only.
      const body =
        parsed.text?.trim() ||
        (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");

      const attachments = (parsed.attachments ?? [])
        .map((a: any) => `${a.filename ?? "unnamed"} (${Math.round((a.size ?? 0) / 1024)}KB)`)
        .join(", ");

      const clipped =
        body.length > 12_000 ? body.slice(0, 12_000) + "\n[...truncated]" : body;

      return [
        `From:    ${addressOf(parsed.from)}`,
        `To:      ${addressOf(parsed.to)}`,
        `Date:    ${formatDate(parsed.date)}`,
        `Subject: ${parsed.subject ?? "(no subject)"}`,
        attachments ? `Files:   ${attachments}` : "",
        "",
        clipped || "(empty message)",
      ]
        .filter((line) => line !== "")
        .join("\n");
    } catch (err) {
      return `Could not read message ${uid}: ${(err as Error).message}`;
    } finally {
      await connection?.close();
    }
  },
};

/** Withheld unless IMAP is configured — a tool that can only fail wastes the
 *  model's attention on a dead end. */
// Offered when either backend can serve it: IMAP config, or a connected
// account holding the read grant. Evaluated at load like every other
// config gate -- connecting an account mid-session shows up on restart.
/** A Gmail message id opens in the web client at this address; "#all"
 *  finds it whatever label it carries. Only ever built from an id the
 *  account itself returned. */
export function gmailLink(id: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}`;
}

export const mailTools: BuiltinTool[] =
  mailConfigured() || anyMailReadAccount() ? [searchTool, readTool] : [];
