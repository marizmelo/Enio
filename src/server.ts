import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { runTurn } from "./agent.js";
import { buildRegistry, type Registry } from "./tools/index.js";
import { setMemorySession } from "./tools/memory.js";
import { startSession } from "./memory/store.js";
import { ensureToken, isAuthorized } from "./auth.js";
import { mentionContext, parseMentions } from "./mentions.js";
import { SPECIALISTS } from "./specialists.js";
import { loadSkills } from "./skills.js";
import type { Message } from "./types.js";

/**
 * An OpenAI-compatible endpoint that wraps the *agent*, not the raw model.
 *
 * The distinction matters: mlx_lm.server on :8080 already speaks this protocol,
 * but it has no tools and no memory. This sits in front of it on :8787 so
 * anything that can point at an OpenAI base URL — Open WebUI, a script, an
 * editor extension — gets the full agent, tool execution and recall included,
 * without knowing anything about how it works.
 */

export async function serve(): Promise<void> {
  const registry = await buildRegistry((m) => console.log(m));
  const sessionId = startSession();
  setMemorySession(sessionId);
  const token = ensureToken();

  const server = createServer((req, res) => {
    handle(req, res, registry, sessionId, token).catch((err) => {
      sendJson(res, 500, { error: { message: (err as Error).message } });
    });
  });

  server.listen(config.agentPort, config.agentHost, () => {
    const shown = config.agentHost === "0.0.0.0" ? "<this-machine>" : config.agentHost;
    console.log(`\nenio listening on http://${shown}:${config.agentPort}/v1`);
    console.log(`  ${registry.all.length} tools · upstream ${config.modelBaseUrl}`);
    console.log(`\n  API key: ${token}`);
    console.log(`  ${DIM}paste that into any OpenAI-compatible client's API key field${RESET}`);

    if (config.agentHost !== "127.0.0.1" && config.agentHost !== "localhost") {
      console.log(
        `\n  ${YELLOW}Bound to ${config.agentHost}, so this is reachable from your network.${RESET}` +
          `\n  ${YELLOW}This agent can run shell commands. Keep the key secret, and prefer${RESET}` +
          `\n  ${YELLOW}a tunnel (see tunnel.md) over exposing the port directly.${RESET}`,
      );
    }
    console.log("");
  });
}

const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  registry: Registry,
  sessionId: string,
  token: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.agentPort}`);

  // Preflight, so browser-based clients can send the Authorization header.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": req.headers.origin ?? "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Max-Age": "600",
    });
    res.end();
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");

  // Deliberately unauthenticated and deliberately empty: clients need a way to
  // tell whether the server is up before they have a token, and this reveals
  // nothing — not the tool count, not the model, not the version.
  if (req.method === "GET" && url.pathname === "/ping") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isAuthorized(req, token)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="enio"');
    sendJson(res, 401, {
      error: {
        message:
          "Missing or invalid API key. Send it as 'Authorization: Bearer <key>'. " +
          "Find yours with: enio token",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: [{ id: "enio", object: "model", owned_by: "local" }],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, tools: registry.all.length });
    return;
  }

  /**
   * What this agent can do, as data.
   *
   * A client that wants to show the user their options should not have to ask
   * the model. The model only ever sees one specialist's slice of the registry,
   * so it answers "what tools do you have" with two when there are eleven —
   * accurate for the turn, wrong as an answer. This is the whole picture, it
   * costs no tokens, and it cannot hallucinate.
   */
  if (req.method === "GET" && url.pathname === "/capabilities") {
    const ctx = mentionContext(registry);
    sendJson(res, 200, {
      tools: registry.all.map((t) => ({
        name: t.name,
        description: t.description,
        origin: t.origin,
        server: t.server ?? null,
      })),
      skills: loadSkills().skills.map((s) => ({
        name: s.name,
        description: s.description,
      })),
      agents: SPECIALISTS.map((s) => ({
        name: s.name,
        description: s.description,
        tools: s.tools,
      })),
      servers: ctx.servers,
      files: ctx.files,
    });
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    sendJson(res, 404, { error: { message: "Not found" } });
    return;
  }

  const body = await readBody(req);
  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON body" } });
    return;
  }

  const incoming: Message[] = Array.isArray(payload?.messages) ? payload.messages : [];
  const lastUser = [...incoming].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    sendJson(res, 400, { error: { message: "No user message provided" } });
    return;
  }

  // Prior turns become history; the final user message drives this turn.
  const history: Message[] = incoming
    .filter((m) => m !== lastUser && m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content ?? "" }));

  // Resolve /skill and @mentions here rather than only in the REPL. Without
  // this the grammar existed but only one client could speak it: "@notes.txt"
  // typed into the desktop app reached the model as literal text, which looks
  // like the feature is broken rather than absent. Anything unrecognised is
  // left verbatim, so an email address is still never eaten.
  const mentions = parseMentions(String(lastUser.content ?? ""), mentionContext(registry));
  const prompt = mentions.text;
  const overrides = {
    specialist: mentions.specialist,
    skills: mentions.skills,
    files: mentions.files,
    servers: mentions.servers,
  };

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (payload?.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const emit = (delta: Record<string, unknown>) => {
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: "enio",
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`,
      );
    };

    emit({ role: "assistant", content: "" });

    // Throttled: a reasoning delta can arrive per token, and a frame each would
    // be more traffic than the answer.
    let thoughtChars = 0;
    let lastThinkAt = 0;

    try {
      await runTurn(
        prompt,
        history,
        registry,
        sessionId,
        {
          onContent: (d) => emit({ content: d }),
          // Reasoning is stripped before it reaches any client, which is right
          // -- it is not the answer. But it is also the entire wait: the model
          // can spend a minute in <think> while the window shows nothing, and
          // a spinner that cannot say how long it has been spinning is
          // indistinguishable from one that is stuck. Only the running size is
          // sent, never the text.
          onReasoning: (d) => {
            thoughtChars += d.length;
            const now = Date.now();
            if (now - lastThinkAt >= 250) {
              lastThinkAt = now;
              res.write(`: think ${thoughtChars}\n\n`);
            }
          },
          // Surfaced as a comment frame so clients that don't understand it ignore
          // it, rather than rendering tool chatter as assistant text.
          onToolStart: (name) => res.write(`: tool ${name}\n\n`),
          // Same channel, same reason. A widget is decoration for a client that
          // can draw it; the tool's text has already gone to the model and to
          // every client that cannot, so dropping this loses nothing.
          onWidget: (widget) => res.write(`: widget ${JSON.stringify(widget)}\n\n`),
        },
        overrides,
      );
    } catch (err) {
      emit({ content: `\n[error: ${(err as Error).message}]` });
    }
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: "enio",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const result = await runTurn(prompt, history, registry, sessionId, {}, overrides);

  sendJson(res, 200, {
    id,
    object: "chat.completion",
    created,
    model: "enio",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.reply },
        finish_reason: "stop",
      },
    ],
    // Not part of the OpenAI schema, but useful and ignored by clients that
    // don't look for it.
    x_tools_used: result.toolsUsed,
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 4_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolvePromise(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
