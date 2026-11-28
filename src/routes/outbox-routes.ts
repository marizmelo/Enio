import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../http-util.js";
import {
  discardDraft,
  draftView,
  getDraft,
  listDrafts,
  recordDraftOutcome,
  sendDraft,
  updateDraft,
  type OutboxFailure,
} from "../outbox.js";

/**
 * The outbox over HTTP: what is waiting, an edit, Send, Discard.
 *
 * These are the routes mail leaves by, and there is no other: no tool
 * reaches a transport. So whoever holds the bearer token can send a
 * waiting message -- as they could already run a command through the coder.
 * What they cannot do here is write one: there is no route that creates a
 * draft, so a message that goes out was written in a turn a person can
 * read, and edited (if at all) by someone holding the token.
 *
 * Send takes the revision the client was showing. Without it a Send from
 * a window that had not noticed an edit made elsewhere would send text
 * the person pressing the button never read.
 */
const STATUS: Record<OutboxFailure["code"], number> = {
  not_found: 404,
  not_waiting: 409,
  changed: 409,
  invalid: 400,
  sending_off: 409,
  failed: 502,
};

const refuse = (res: ServerResponse, failure: OutboxFailure) =>
  sendJson(res, STATUS[failure.code], { error: { code: failure.code, message: failure.message } });

export async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/outbox") {
    // Waiting ones by default: that is what a window has to draw. The
    // whole record (sent, discarded, replaced) on request.
    const all = url.searchParams.get("all") === "1";
    const session = url.searchParams.get("session") ?? undefined;
    const drafts = listDrafts({ status: all ? undefined : "pending", sessionId: session });
    sendJson(res, 200, { drafts: drafts.map(draftView) });
    return true;
  }

  const one = /^\/outbox\/([0-9a-f-]{36})(?:\/(send|discard))?$/.exec(url.pathname);
  if (!one) return false;
  const [, id, action] = one;

  if (req.method === "GET" && !action) {
    const draft = getDraft(id!);
    if (draft) sendJson(res, 200, { draft: draftView(draft) });
    else sendJson(res, 404, { error: { code: "not_found", message: "No such message." } });
    return true;
  }

  let body: Record<string, unknown> = {};
  if (req.method === "PUT" || req.method === "POST") {
    try {
      const parsed: unknown = JSON.parse((await readBody(req)) || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: { code: "invalid", message: "Body must be JSON." } });
      return true;
    }
  }
  const revision = Number.isInteger(body.revision) ? (body.revision as number) : null;

  if (req.method === "PUT" && !action) {
    if (revision === null) {
      sendJson(res, 400, { error: { code: "invalid", message: "An edit names the revision it was made to." } });
      return true;
    }
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    const done = updateDraft(id!, revision, {
      to: text(body.to),
      cc: text(body.cc),
      subject: text(body.subject),
      body: text(body.body),
    });
    if (done.ok) sendJson(res, 200, { draft: draftView(done.draft) });
    else refuse(res, done);
    return true;
  }

  if (req.method === "POST" && action === "send") {
    if (revision === null) {
      sendJson(res, 400, { error: { code: "invalid", message: "A send names the revision that was read." } });
      return true;
    }
    const done = await sendDraft(id!, revision);
    if (!done.ok) {
      // The draft as it stands now, so the window can show the reason on
      // it and the revision a retry has to name.
      const now = getDraft(id!);
      sendJson(res, STATUS[done.code], {
        error: { code: done.code, message: done.message },
        ...(now ? { draft: draftView(now) } : {}),
      });
      return true;
    }
    sendJson(res, 200, { draft: draftView(done.draft), reply: recordDraftOutcome(done.draft) });
    return true;
  }

  if (req.method === "POST" && action === "discard") {
    const done = discardDraft(id!);
    if (done.ok) sendJson(res, 200, { draft: draftView(done.draft), reply: recordDraftOutcome(done.draft) });
    else refuse(res, done);
    return true;
  }

  return false;
}
