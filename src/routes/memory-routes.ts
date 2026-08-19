import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../http-util.js";
import {
  forgetFact,
  forgetSummary,
  listFacts,
  listSummaries,
  rememberFact,
  setFactPinned,
} from "../memory/store.js";
import { distilFacts } from "../memory/distil.js";
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
  /**
   * "Remember this" under a reply. Two steps on purpose: distil returns the
   * candidate facts for the user to read and prune, and only /memory/facts
   * writes -- what lands in memory is what the user saw and approved, not
   * what the model produced. The session id is recorded so the facts show
   * up under their conversation in the history dialog and die with it if
   * the user chooses "forget" there.
   */
  if (req.method === "POST" && url.pathname === "/memory/distil") {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      question?: string;
      answer?: string;
    };
    const out = await distilFacts(String(body.question ?? ""), String(body.answer ?? ""));
    sendJson(res, out.ok ? 200 : 422, out);
    return true;
  }
  if (req.method === "POST" && url.pathname === "/memory/facts") {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      facts?: unknown;
      sessionId?: string;
      pinned?: boolean;
    };
    const facts = (Array.isArray(body.facts) ? body.facts : [])
      .map((f) => String(f ?? "").trim())
      .filter((f) => f.length >= 3)
      .slice(0, 5);
    if (facts.length === 0) {
      sendJson(res, 400, { error: { message: "Nothing to remember." } });
      return true;
    }
    const stored: string[] = [];
    const skipped: string[] = [];
    for (const fact of facts) {
      const r = await rememberFact(fact, {
        pinned: body.pinned === true,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        source: "user",
      });
      (r.stored ? stored : skipped).push(fact);
    }
    sendJson(res, 200, { stored, skipped });
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
