import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../http-util.js";
import {
  forgetFact,
  forgetSummary,
  listFacts,
  listSummaries,
  setFactPinned,
} from "../memory/store.js";
import { graphView } from "../memory/traces.js";
import { listPreferences, removePreference } from "../memory/learning.js";

/** True when this feature owned the request. Moved verbatim from server.ts —
 *  the routes stay thin, the feature module owns every decision. */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  /**
   * What memory holds about the user — the desktop's Memory dialog.
   *
   * One read route, thin mutation routes. Everything here is the management
   * surface that was missing: facts and preferences were writable from chat
   * and the CLI but listable nowhere, and the summaries feeding every turn's
   * memory block were invisible outside the inspector.
   */
  if (req.method === "GET" && url.pathname === "/memory") {
    sendJson(res, 200, {
      facts: listFacts(),
      preferences: listPreferences(),
      summaries: listSummaries(),
    });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/memory/graph") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 150) || 150, 300);
    sendJson(res, 200, graphView(limit));
    return true;
  }
  const factRoute = /^\/memory\/facts\/(\d+)$/.exec(url.pathname);
  if (factRoute) {
    const id = Number(factRoute[1]);
    if (req.method === "DELETE") {
      sendJson(res, forgetFact(String(id)) ? 200 : 404, { ok: true });
      return true;
    }
    if (req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { pinned?: boolean };
      sendJson(res, setFactPinned(id, body?.pinned === true) ? 200 : 404, { ok: true });
      return true;
    }
  }
  const prefRoute = /^\/memory\/preferences\/(\d+)$/.exec(url.pathname);
  if (prefRoute && req.method === "DELETE") {
    sendJson(res, removePreference(prefRoute[1]!) ? 200 : 404, { ok: true });
    return true;
  }
  const summaryRoute = /^\/memory\/summaries\/([A-Za-z0-9-]+)$/.exec(url.pathname);
  if (summaryRoute && req.method === "DELETE") {
    sendJson(res, forgetSummary(summaryRoute[1]!) ? 200 : 404, { ok: true });
    return true;
  }
  return false;
}
