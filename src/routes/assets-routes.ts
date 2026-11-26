import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../http-util.js";
import { listAssets, removeAsset } from "../assets.js";

/**
 * Assets over HTTP: the list, and removal. Thin on purpose — what an asset
 * is, where it lives and what it says about itself is assets.ts.
 *
 * There is no route that creates one or edits its origin. An asset comes
 * into being when a turn writes a file, and its origin is what the harness
 * observed at that moment; a client able to rewrite that would make "what
 * made this" something a page could be told to say.
 */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/assets") {
    sendJson(res, 200, { assets: listAssets() });
    return true;
  }
  const one = /^\/assets\/([A-Za-z0-9._-]{1,160})$/.exec(url.pathname);
  if (one && req.method === "DELETE") {
    // Only assets in the store. A file from before assets is listed where
    // it sits and its id is its path, which this pattern cannot match: it
    // is removed the way it always was, by the person, in Finder.
    if (removeAsset(one[1]!)) sendJson(res, 200, { removed: true });
    else sendJson(res, 404, { error: { message: "No such asset." } });
    return true;
  }
  return false;
}
