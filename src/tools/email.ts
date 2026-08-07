import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import type { ToolDef } from "../types.js";

/**
 * Sending email over SMTP.
 *
 * Works with any provider or your own server. Not an MCP server: it is one
 * dependency and about thirty lines, and a separate process would cost a tool
 * slot for no benefit.
 *
 * The default is DRY RUN, and that is deliberate. Sending is irreversible, and
 * the model deciding to send is exactly the kind of judgement a ~1B-active
 * model gets wrong. Until you set ENIO_EMAIL_SEND=1, the message is rendered
 * and written to the workspace as a .eml you can open and read, so you find out
 * what it would have said before it says it to anyone.
 */

export const emailConfigured = () => Boolean(config.smtpHost && config.emailFrom);

function recipientAllowed(to: string): boolean {
  if (config.emailAllowedTo.length === 0) return true;
  const address = to.toLowerCase().trim();
  return config.emailAllowedTo.some((allowed) => {
    const rule = allowed.toLowerCase().trim();
    // A bare domain rule permits everyone at that domain.
    return rule.startsWith("@") ? address.endsWith(rule) : address === rule;
  });
}

const emailTool: ToolDef = {
  name: "send_email",
  description:
    "Send an email. Give the recipient, a subject, and the body as plain text. Confirm the recipient and content with the user before calling this — sending cannot be undone.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient address." },
      subject: { type: "string", description: "Subject line." },
      body: { type: "string", description: "Message body, plain text." },
      cc: { type: "string", description: "Optional. Comma-separated cc addresses." },
    },
    required: ["to", "subject", "body"],
  },
  async run(args) {
    const to = String(args.to ?? "").trim();
    const subject = String(args.subject ?? "").trim();
    const body = String(args.body ?? "");

    if (!to.includes("@")) return `"${to}" is not an email address.`;
    if (!subject) return "Refusing to send with no subject.";

    if (!recipientAllowed(to)) {
      return (
        `Refused: ${to} is not in the allowed recipient list ` +
        `(${config.emailAllowedTo.join(", ")}). Change ENIO_EMAIL_ALLOWED_TO to permit it.`
      );
    }

    const rendered =
      `From: ${config.emailFrom}\nTo: ${to}\n` +
      (args.cc ? `Cc: ${args.cc}\n` : "") +
      `Subject: ${subject}\n\n${body}\n`;

    if (!config.emailSend) {
      // Dry run: write it out so it can actually be inspected.
      const file = join(config.workspace, `draft-${Date.now()}.eml`);
      await writeFile(file, rendered, "utf8");
      return (
        `DRY RUN — nothing was sent.\n\n${rendered}\n` +
        `Saved to ${file}\n` +
        `Set ENIO_EMAIL_SEND=1 to send for real.`
      );
    }

    try {
      const nodemailer = await import("nodemailer");
      const transport = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        // Port 465 is implicit TLS; 587 and 25 start plaintext and upgrade
        // with STARTTLS, which nodemailer does automatically.
        secure: config.smtpPort === 465,
        auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
      });

      const info = await transport.sendMail({
        from: config.emailFrom,
        to,
        cc: args.cc ? String(args.cc) : undefined,
        subject,
        text: body,
      });

      return `Sent to ${to} — message id ${info.messageId}`;
    } catch (err) {
      return `Could not send: ${(err as Error).message}`;
    }
  },
};

/** Withheld entirely when SMTP isn't configured — a tool that always fails
 *  just burns the model's limited attention on a dead end. */
export const emailTools: ToolDef[] = emailConfigured() ? [emailTool] : [];
