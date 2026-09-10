import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../http-util.js";
import { personalityView, setAxis, setCuriosity } from "../personality.js";

/**
 * How the assistant replies — the Memory dialog's Behavior tab.
 *
 * One read that returns exactly what the next turn will render (the same
 * function the turn loop calls, never a trace), and one write per axis
 * that refuses an unknown level rather than storing something the turn
 * would then silently read as "auto".
 */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== "/personality") return false;
  if (req.method === "GET") {
    sendJson(res, 200, personalityView());
    return true;
  }
  if (req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      axis?: unknown;
      level?: unknown;
      curiosity?: unknown;
    };
    try {
      if (typeof body.curiosity === "string") setCuriosity(body.curiosity);
      else setAxis(String(body.axis ?? ""), String(body.level ?? ""));
    } catch (err) {
      sendJson(res, 400, { error: { message: (err as Error).message } });
      return true;
    }
    sendJson(res, 200, personalityView());
    return true;
  }
  return false;
}
