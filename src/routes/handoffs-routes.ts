import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../http-util.js";
import {
  HandoffRefused,
  availableAgents,
  cancelHandoffRun,
  listHandoffRuns,
  openSignin,
  startHandoffRun,
} from "../handoffs.js";

/** True when this feature owned the request. Moved verbatim from server.ts —
 *  the routes stay thin, the feature module owns every decision. */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  /**
   * Handoff runs: a reviewed handoff file, executed by the user's own CLI
   * agent as a background job. Thin routes; the machine is handoffs.ts.
   */
  if (req.method === "GET" && url.pathname === "/handoffs") {
    sendJson(res, 200, { agents: availableAgents(), runs: listHandoffRuns() });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/handoffs/run") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        path?: string;
        provider?: string;
      };
      const run = startHandoffRun(String(body.path ?? ""), String(body.provider ?? ""));
      sendJson(res, 202, { run });
    } catch (err) {
      const status = err instanceof HandoffRefused ? 409 : 500;
      sendJson(res, status, { error: { message: (err as Error).message } });
    }
    return true;
  }
  const handoffCancel = /^\/handoffs\/([a-z0-9-]+)$/.exec(url.pathname);
  if (handoffCancel && req.method === "DELETE") {
    sendJson(res, cancelHandoffRun(handoffCancel[1]!) ? 200 : 404, { ok: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/handoffs/signin") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}") as { provider?: string };
      await openSignin(String(body.provider ?? ""));
      sendJson(res, 200, { ok: true });
    } catch (err) {
      const status = err instanceof HandoffRefused ? 409 : 500;
      sendJson(res, status, { error: { message: (err as Error).message } });
    }
    return true;
  }
  return false;
}
