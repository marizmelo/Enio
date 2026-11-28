import { config } from "../config.js";
import { scriptMailAccount } from "../accounts.js";
import { addressesIn, ccNote, recipientAllowed, renderDraft, smtpConfigured, writeDraft, type Draft } from "../outbox.js";
import type { BuiltinTool } from "../types.js";

/**
 * Writing email. Not sending it.
 *
 * `send_email` keeps its name and its arguments, and no longer reaches a
 * mail transport: it writes the message into the outbox (outbox.ts) and
 * the turn ends there, on a sentence the harness writes. A person sends
 * it, from the card, the terminal or an authenticated request.
 *
 * The name is kept because it is model-facing: the router's examples, the
 * abilities and the model's own habit all say send_email, and a renamed
 * key is a working classifier re-learned. What changed is what calling it
 * does, and the description says so.
 */

export const emailConfigured = smtpConfigured;
export { addressesIn, recipientAllowed };

/** What the person reads when a message has been written. The whole
 *  message is in it, so a surface with no card (the terminal, a plain API
 *  client, a step of an automation) shows the same thing the card does. */
export function writtenReply(draft: Draft, replaced: boolean, noCard = false): string {
  // Said before the press, not after it: on a connected account a Cc is
  // not delivered (the bridge sends to To only) and a line naming those
  // people is added to the body. Shown only in the outcome, the person
  // learned it once the message had gone.
  const cc = ccNote(draft);
  return (
    `I wrote this message. It has not been sent.${replaced ? " It replaces the one I wrote before." : ""}\n\n` +
    `${renderDraft(draft)}\n\n` +
    (cc ? `${cc}\n\n` : "") +
    // A run nobody started from a conversation has no card: say where
    // the message is, in words that are true there.
    (noCard
      ? "It is waiting in the outbox for you to send. In a terminal, `enio outbox` lists it." +
        (config.emailSend ? "" : " Sending is switched off on this machine (ENIO_EMAIL_SEND=1 turns it on).")
      : config.emailSend
        ? "It is waiting for you: send it, change it, or discard it."
        : "It is waiting for you. Sending is switched off on this machine (ENIO_EMAIL_SEND=1 turns it on), so for now it can be changed or discarded, and it is saved as a draft.")
  );
}

const emailTool: BuiltinTool = {
  name: "send_email",
  description:
    "Write an email for the user to send. Give the recipient, a subject, and the body as plain text. This does not send: the user is shown the message and sends it themselves. Call it as soon as you know who it is for and what to say; to change a message, call it again with the whole new message. Never write the message out in your reply.",
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
    const written = writeDraft({
      to: String(args.to ?? ""),
      cc: args.cc === undefined ? undefined : String(args.cc),
      subject: String(args.subject ?? ""),
      body: String(args.body ?? ""),
    });
    if (!written.ok) return written.reason;
    const draft = written.draft;
    return {
      // The artifact line first: a long body is cut at the tool-output
      // limit, and after the body the line that names the file was the
      // part that went.
      text:
        `Written, not sent.${draft.file ? `\nSaved to ${draft.file}` : ""}\n\n${renderDraft(draft)}\n\n` +
        "The user has been shown this message and will send it themselves. Do not call another tool.",
      widget: {
        type: "mail",
        id: draft.id,
        revision: draft.revision,
        from: draft.from,
        to: draft.to,
        cc: draft.cc,
        subject: draft.subject,
        body: draft.body,
        sendingOn: config.emailSend,
      },
      final: writtenReply(draft, false),
    };
  },
};

/** Withheld entirely when nothing could send — a tool that always fails
 *  just burns the model's limited attention on a dead end. */
export const emailTools: BuiltinTool[] =
  emailConfigured() || scriptMailAccount("send") ? [emailTool] : [];
