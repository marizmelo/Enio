import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../http-util.js";
import { appsStatus, openInEditor, setEditor } from "../apps.js";
import { safePath } from "../tools/fs.js";

/**
 * The user's apps, over the authed loopback: which editor, and "open this
 * there". The path arrives in the same alias grammar the tools use and goes
 * through safePath, so a client can only open what the person attached or
 * Enio wrote -- never an arbitrary string handed to a shell.
 */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === "/apps") {
    if (req.method !== "GET") return false;
    sendJson(res, 200, appsStatus());
    return true;
  }
  if (url.pathname === "/apps/editor") {
    if (req.method !== "POST") return false;
    const body = JSON.parse((await readBody(req)) || "{}") as { id?: unknown };
    try {
      setEditor(body.id == null || body.id === "" ? null : String(body.id));
      sendJson(res, 200, appsStatus());
    } catch (err) {
      sendJson(res, 400, { error: { message: (err as Error).message } });
    }
    return true;
  }
  if (url.pathname === "/apps/open") {
    if (req.method !== "POST") return false;
    const body = JSON.parse((await readBody(req)) || "{}") as { path?: unknown; line?: unknown; editor?: unknown };
    let abs: string;
    try {
      abs = safePath(String(body.path ?? ""));
    } catch (err) {
      sendJson(res, 400, { error: { message: (err as Error).message } });
      return true;
    }
    const line = Number(body.line);
    const result = openInEditor(abs, {
      line: Number.isFinite(line) && line > 0 ? line : undefined,
      editorId: body.editor ? String(body.editor) : null,
    });
    if (!result.ok) {
      sendJson(res, 409, { error: { message: result.reason } });
      return true;
    }
    sendJson(res, 200, result);
    return true;
  }
  return false;
}
