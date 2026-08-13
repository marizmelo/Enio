import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../http-util.js";
import {
  MeetingRefused,
  addSegment,
  cancelMeeting,
  listMeetingFiles,
  meetingState,
  startMeeting,
  stopMeeting,
} from "../meetings.js";

/** True when this feature owned the request. Moved verbatim from server.ts —
 *  the routes stay thin, the feature module owns every decision. */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  /**
   * Meeting capture. Thin on purpose: routes parse and reply, the tested
   * module owns every decision. Start and stop are USER acts arriving here
   * from the desktop's record button -- no tool anywhere can reach these,
   * which is what makes a fabricated "I stopped the recording and here is
   * the summary" structurally impossible.
   */
  if (req.method === "POST" && url.pathname === "/meetings/start") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      sendJson(res, 200, { meeting: startMeeting(body?.topic ? String(body.topic) : undefined) });
    } catch (err) {
      if (err instanceof MeetingRefused) {
        sendJson(res, err.message.includes("install") ? 503 : 409, {
          error: { message: err.message },
        });
      } else {
        sendJson(res, 400, { error: { message: (err as Error).message } });
      }
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/meetings/segment") {
    const seq = Number(url.searchParams.get("seq"));
    if (!Number.isInteger(seq) || seq < 0) {
      sendJson(res, 400, { error: { message: "seq must be a non-negative integer" } });
      return true;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      // A 45s segment is ~1.4MB; 8MB is generous headroom, and anything
      // past it is not a segment.
      if (size > 8 * 1024 * 1024) {
        sendJson(res, 413, { error: { message: "Segment too large." } });
        return true;
      }
      chunks.push(chunk as Buffer);
    }
    const wav = Buffer.concat(chunks);
    if (wav.length < 44) {
      sendJson(res, 400, { error: { message: "Not a WAV file." } });
      return true;
    }
    try {
      sendJson(res, 202, { meeting: addSegment(wav, seq) });
    } catch (err) {
      sendJson(res, err instanceof MeetingRefused ? 409 : 500, {
        error: { message: (err as Error).message },
      });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/meetings/stop") {
    try {
      sendJson(res, 202, { meeting: stopMeeting() });
    } catch (err) {
      sendJson(res, err instanceof MeetingRefused ? 409 : 500, {
        error: { message: (err as Error).message },
      });
    }
    return true;
  }
  if (req.method === "GET" && url.pathname === "/meetings") {
    // null is a real answer: nothing recording, same contract as /model/download.
    sendJson(res, 200, { meeting: meetingState() });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/meetings/files") {
    // The written records, identified by topic — the Notes panel's
    // Meetings section. Read off the disk each time; the files ARE the store.
    sendJson(res, 200, { meetings: listMeetingFiles() });
    return true;
  }
  if (req.method === "DELETE" && url.pathname === "/meetings") {
    sendJson(res, 200, { cancelled: cancelMeeting() });
    return true;
  }
  return false;
}
