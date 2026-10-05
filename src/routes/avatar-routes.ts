import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { readBody, sendJson } from "../http-util.js";
import { avatarStatus, resolveAvatarFile, setAvatarBody } from "../avatar.js";

/**
 * The avatar file, over the same authed loopback channel as everything
 * else. The renderer cannot read the data dir itself (file: fetches are
 * blocked in the sandboxed window), and a static route is simpler and
 * safer than a privileged custom protocol: no path parameter exists here,
 * so no client-supplied string ever reaches the filesystem.
 *
 * The body is streamed, never read into memory -- the file is tens of
 * megabytes and a conditional request answers with nothing at all.
 */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname === "/avatar") {
    if (req.method !== "GET") return false;
    sendJson(res, 200, avatarStatus());
    return true;
  }

  if (url.pathname === "/avatar/body") {
    if (req.method !== "POST") return false;
    const body = JSON.parse((await readBody(req)) || "{}") as { body?: unknown };
    try {
      sendJson(res, 200, setAvatarBody(String(body.body ?? "")));
    } catch (err) {
      sendJson(res, 400, { error: { message: (err as Error).message } });
    }
    return true;
  }

  if (url.pathname === "/avatar/model") {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const file = resolveAvatarFile();
    if (!file) {
      sendJson(res, 404, {
        error: { message: "No avatar is installed. Run: enio addons add avatar — or enio avatar use <file.glb>" },
      });
      return true;
    }
    const st = statSync(file.path);
    const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "model/gltf-binary",
      "Content-Length": String(st.size),
      ETag: etag,
      "Last-Modified": st.mtime.toUTCString(),
      "Cache-Control": "private, max-age=0, must-revalidate",
    });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    try {
      await pipeline(createReadStream(file.path), res);
    } catch {
      // The client went away mid-file; there is nobody left to answer.
      res.destroy();
    }
    return true;
  }

  return false;
}
