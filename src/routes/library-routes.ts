import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../http-util.js";
import { libraryStatus, scanLibrary } from "../library.js";

/** True when this feature owned the request. Moved verbatim from server.ts —
 *  the routes stay thin, the feature module owns every decision. */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/library") {
    sendJson(res, 200, { library: libraryStatus() });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/library/scan") {
    try {
      sendJson(res, 200, { report: await scanLibrary() });
    } catch (err) {
      sendJson(res, 500, { error: { message: (err as Error).message } });
    }
    return true;
  }
  return false;
}
