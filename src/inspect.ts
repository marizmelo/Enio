import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { config, projectRoot } from "./config.js";
import { ensureToken, isAuthorized } from "./auth.js";
import {
  deleteEdge,
  deleteEntity,
  graphView,
  listSessions,
  turnCount,
  turnsForSession,
} from "./memory/traces.js";
import { stats } from "./memory/store.js";

/**
 * The inspector: a local web UI over the trace database.
 *
 * This exists because generic LLM observability tools can't answer the question
 * that actually matters here. They see prompt-in, completion-out. They have no
 * concept of which memories were retrieved, which specialist was picked, or
 * whether a tool call had to be scavenged out of plain text — and with a
 * ~1B-active model those are precisely the failures worth finding.
 *
 * Read-only except for pruning the knowledge graph, which is the one place
 * manual correction pays off: extraction is imperfect by design, and deleting a
 * wrong triple is faster than trying to prompt around it.
 */

const UI_DIR = join(projectRoot, "ui", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

export async function inspect(): Promise<void> {
  const token = ensureToken();
  const port = config.inspectPort;

  try {
    await stat(join(UI_DIR, "index.html"));
  } catch {
    console.error(
      `\nThe inspector UI hasn't been built yet.\n\n` +
        `  cd ui && npm install && npm run build\n\n` +
        `(the installer does this for you)\n`,
    );
    process.exit(1);
  }

  const server = createServer((req, res) => {
    handle(req, res, token).catch((err) => {
      json(res, 500, { error: (err as Error).message });
    });
  });

  server.listen(port, "127.0.0.1", () => {
    const counts = stats();
    console.log(`\n  inspector  http://127.0.0.1:${port}/?k=${token}`);
    console.log(
      `\x1b[2m  ${turnCount()} turns · ${counts.entities} entities · ` +
        `${counts.edges} edges\x1b[0m`,
    );
    console.log(`\x1b[2m  open that URL — the key is in it\x1b[0m\n`);
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.inspectPort}`);
  const path = url.pathname;

  if (path.startsWith("/api/")) {
    if (!isAuthorized(req, token)) {
      json(res, 401, { error: "Invalid or missing API key." });
      return;
    }
    await api(req, res, path, url);
    return;
  }

  // The index page is the only route that gets the token, injected server-side
  // so the bundle never has to ask for it. Accepting it as ?k= lets the printed
  // URL be clickable, which beats making someone paste a 43-character key.
  if (path === "/" || path === "/index.html") {
    const provided = url.searchParams.get("k");
    if (provided !== token) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<body style="font:15px -apple-system,sans-serif;padding:3rem;max-width:34rem">
         <h2>Key required</h2>
         <p>Open the URL printed by <code>enio inspect</code>, or run
         <code>enio token</code> and append <code>?k=&lt;key&gt;</code>.</p></body>`,
      );
      return;
    }

    let html = await readFile(join(UI_DIR, "index.html"), "utf8");
    html = html.replace(
      "</head>",
      `<script>window.__ENIO_TOKEN__=${JSON.stringify(token)}</script></head>`,
    );
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      // The token is in this document; it must not be cached to disk.
      "Cache-Control": "no-store",
    });
    res.end(html);
    return;
  }

  await serveStatic(res, path);
}

/** Static assets carry no secrets, so they need no key — but they must not be
 *  a path-traversal hole into the rest of the filesystem. */
async function serveStatic(res: ServerResponse, path: string): Promise<void> {
  const target = resolve(UI_DIR, "." + normalize(path));
  if (target !== UI_DIR && !target.startsWith(UI_DIR + sep)) {
    json(res, 403, { error: "Forbidden" });
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      "Content-Type": MIME[extname(target)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

async function api(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
): Promise<void> {
  if (req.method === "GET" && path === "/api/stats") {
    json(res, 200, { ...stats(), turns: turnCount() });
    return;
  }

  if (req.method === "GET" && path === "/api/sessions") {
    json(res, 200, listSessions());
    return;
  }

  const turns = /^\/api\/sessions\/([^/]+)\/turns$/.exec(path);
  if (req.method === "GET" && turns) {
    json(res, 200, turnsForSession(decodeURIComponent(turns[1]!)));
    return;
  }

  if (req.method === "GET" && path === "/api/graph") {
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit")) || 300));
    json(res, 200, graphView(limit));
    return;
  }

  const edge = /^\/api\/graph\/edges\/(\d+)$/.exec(path);
  if (req.method === "DELETE" && edge) {
    json(res, 200, { deleted: deleteEdge(Number(edge[1])) });
    return;
  }

  const entity = /^\/api\/graph\/entities\/(\d+)$/.exec(path);
  if (req.method === "DELETE" && entity) {
    json(res, 200, { deleted: deleteEntity(Number(entity[1])) });
    return;
  }

  json(res, 404, { error: "Not found" });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
