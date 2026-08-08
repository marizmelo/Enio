import { config } from "../config.js";
import type { ToolDef } from "../types.js";

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

const searchTool: ToolDef = {
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
    },
    required: [],
  },
  async run(args) {
    const folder = String(args.folder ?? config.imapFolders[0] ?? "INBOX");
    const limit = Math.min(25, Math.max(1, Number(args.limit ?? 10) || 10));
    const days = Math.max(1, Number(args.days ?? 30) || 30);

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

const readTool: ToolDef = {
  name: "read_email",
  description:
    "Read one message in full by the id from search_email. Returns the headers and the body as plain text.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      id: { type: "number", description: "The [id] shown by search_email." },
      folder: { type: "string", description: `Optional. Default ${config.imapFolders[0] ?? "INBOX"}.` },
    },
    required: ["id"],
  },
  async run(args) {
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
export const mailTools: ToolDef[] = mailConfigured() ? [searchTool, readTool] : [];
