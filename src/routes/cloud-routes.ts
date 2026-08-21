import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../http-util.js";
import {
  cloudTarget,
  cloudTargets,
  sendToCloud,
  setCloudKey,
  setCloudTarget,
} from "../cloud.js";

/**
 * Setting up and using a frontier model.
 *
 * Behind the same bearer auth as everything else, and deliberately reachable
 * only from a client: no tool calls these, so escalating to the cloud stays
 * something a person does. That is what keeps the DECISIONS rule intact --
 * what was rejected is data leaving *quietly*, and a button on a payload you
 * can read is the opposite of quiet.
 *
 * A key goes in and never comes back out. The listing says whether one is
 * held, never what it is, because an endpoint that returns credentials turns
 * every future bug in this file into a leak.
 */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/cloud") {
    sendJson(res, 200, { targets: await cloudTargets(), target: cloudTarget() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/cloud/target") {
    const body = JSON.parse((await readBody(req)) || "{}") as { target?: string | null };
    try {
      setCloudTarget(body.target ?? null);
      sendJson(res, 200, { target: cloudTarget() });
    } catch (err) {
      sendJson(res, 400, { error: { message: (err as Error).message } });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/cloud/key") {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      provider?: string;
      key?: string;
    };
    try {
      setCloudKey(String(body.provider ?? ""), String(body.key ?? ""));
      // The refreshed listing, so the caller sees the new state without
      // asking again -- and still without the key.
      sendJson(res, 200, { targets: await cloudTargets(), target: cloudTarget() });
    } catch (err) {
      sendJson(res, 400, { error: { message: (err as Error).message } });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/cloud/send") {
    const body = JSON.parse((await readBody(req)) || "{}") as { text?: string };
    const text = String(body.text ?? "");
    if (!text.trim()) {
      sendJson(res, 400, { error: { message: "Nothing to send." } });
      return true;
    }
    // Minutes, not seconds: a frontier model working a packaged task is slow,
    // and the client shows a spinner rather than timing out under it.
    const result = await sendToCloud(text);
    if (result.ok) sendJson(res, 200, { output: result.output });
    else sendJson(res, 502, { error: { message: result.error } });
    return true;
  }

  return false;
}
