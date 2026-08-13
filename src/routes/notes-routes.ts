import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../http-util.js";
import {
  createNote,
  createThread,
  deleteThread,
  listNotes,
  loadThreads,
  locateQuote,
  readNote,
  replyThread,
  resolveNote,
  setThreadResolved,
  transformSelection,
} from "../notes.js";

/** True when this feature owned the request. Moved verbatim from server.ts —
 *  the routes stay thin, the feature module owns every decision. */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  /**
   * The managed note store. Thin: validation and notes.ts calls only.
   * No PUT (bodies save through the desktop's own handler — the recorded
   * "the canvas edits, it never mints" decision) and no DELETE (macOS
   * Trash via the desktop is strictly more reversible than any route).
   */
  if (req.method === "GET" && url.pathname === "/notes") {
    sendJson(res, 200, { notes: listNotes() });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/notes") {
    const body = JSON.parse((await readBody(req)) || "{}") as { title?: string };
    sendJson(res, 200, { note: createNote(body.title) });
    return true;
  }
  const noteRoute = /^\/notes\/([^/]+)(\/comments(?:\/([^/]+)(\/reply|\/resolve)?)?)?$/.exec(
    url.pathname,
  );
  if (noteRoute && url.pathname !== "/notes/transform") {
    const name = decodeURIComponent(noteRoute[1]!);
    if (!resolveNote(name)) {
      sendJson(res, 404, { error: { message: `Not a note: ${name}` } });
      return true;
    }
    const threadId = noteRoute[3] ? decodeURIComponent(noteRoute[3]) : null;
    const tail = noteRoute[4] ?? null;

    if (!noteRoute[2] && req.method === "GET") {
      const note = readNote(name);
      if (!note) sendJson(res, 404, { error: { message: "No such note." } });
      else sendJson(res, 200, note);
      return true;
    }
    if (noteRoute[2] && !threadId) {
      if (req.method === "GET") {
        const { threads, damaged } = loadThreads(name);
        const text = readNote(name)?.content ?? "";
        sendJson(res, 200, {
          damaged,
          threads: threads.map((t) => {
            const hit = locateQuote(text, t.quote, t.prefix, t.suffix);
            return hit ? { ...t, ...hit, orphaned: false } : { ...t, orphaned: true };
          }),
        });
        return true;
      }
      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          quote?: string;
          prefix?: string;
          suffix?: string;
          question?: string;
        };
        const out = await createThread(name, {
          quote: String(body.quote ?? ""),
          prefix: String(body.prefix ?? ""),
          suffix: String(body.suffix ?? ""),
          question: body.question ? String(body.question) : undefined,
        });
        if (out.ok) sendJson(res, 200, { thread: out.thread });
        else sendJson(res, 400, { error: { message: out.reason } });
        return true;
      }
    }
    if (threadId) {
      if (tail === "/reply" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { text?: string };
        const out = await replyThread(name, threadId, String(body.text ?? ""));
        if (out.ok) sendJson(res, 200, { thread: out.thread });
        else sendJson(res, 400, { error: { message: out.reason } });
        return true;
      }
      if (tail === "/resolve" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { resolved?: boolean };
        const out = setThreadResolved(name, threadId, body.resolved === true);
        if (out.ok) sendJson(res, 200, { thread: out.thread });
        else sendJson(res, 404, { error: { message: out.reason } });
        return true;
      }
      if (!tail && req.method === "DELETE") {
        const out = deleteThread(name, threadId);
        sendJson(res, out.ok ? 200 : 404, out.ok ? { ok: true } : { error: { message: out.reason } });
        return true;
      }
    }
  }
  if (req.method === "POST" && url.pathname === "/notes/transform") {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      text?: string;
      start?: number;
      end?: number;
      verb?: string;
      instruction?: string;
    };
    const out = await transformSelection({
      text: String(body.text ?? ""),
      start: Number(body.start),
      end: Number(body.end),
      verb: String(body.verb ?? ""),
      instruction: body.instruction ? String(body.instruction) : undefined,
    });
    if (out.ok) sendJson(res, 200, { replacement: out.replacement });
    else sendJson(res, 400, { error: { message: out.reason } });
    return true;
  }
  return false;
}
