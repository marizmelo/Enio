/**
 * HTTP client for the agent endpoint. This is the only place the renderer
 * talks to the network -- main.js manages backend processes and never touches
 * chat traffic.
 */

const AGENT_BASE = "http://127.0.0.1:8787";
const MODEL_ID = "enio";

/**
 * Parses one SSE event block (everything between two blank lines).
 *
 *   data: {...}     a normal SSE data field, a JSON chat-completion chunk
 *   : tool NAME     a bare SSE *comment*, non-standard, announcing a tool call
 *
 * A spec-following SSE client drops comment lines silently, which is exactly
 * why they are parsed by hand here rather than through EventSource.
 */
export function parseSseEvent(block) {
  let data = null;
  let tool = null;
  let widget = null;
  let think = null;
  let notice = null;
  let context = null;
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) {
      data = (data ?? "") + line.slice(5).trimStart();
    } else if (line.startsWith(":")) {
      const comment = line.slice(1).trim();
      const toolMatch = /^tool\s+(.+)$/.exec(comment);
      if (toolMatch) tool = toolMatch[1];
      const noticeMatch = /^notice\s+(.+)$/.exec(comment);
      if (noticeMatch) notice = noticeMatch[1];
      const thinkMatch = /^think\s+(\d+)$/.exec(comment);
      if (thinkMatch) think = Number(thinkMatch[1]);
      const contextMatch = /^context\s+(\d+)\s+(\d+)$/.exec(comment);
      if (contextMatch) {
        context = { tokens: Number(contextMatch[1]), budget: Number(contextMatch[2]) };
      }
      const widgetMatch = /^widget\s+(.+)$/.exec(comment);
      if (widgetMatch) {
        try {
          widget = JSON.parse(widgetMatch[1]);
        } catch {
          // A malformed payload is dropped rather than thrown: the tool's text
          // is already in the bubble, so this can only ever cost decoration.
          widget = null;
        }
      }
    }
  }
  return { data, tool, widget, think, notice, context };
}

/**
 * The token is fetched lazily and cached, but a null result is NOT cached: on a
 * cold start the file is written only once the agent server boots, so an early
 * miss has to be retried rather than remembered.
 */
let cachedToken = null;
async function authHeaders() {
  if (!cachedToken) {
    try {
      cachedToken = await window.maple?.getToken();
    } catch {
      cachedToken = null;
    }
  }
  const headers = { "Content-Type": "application/json" };
  if (cachedToken) headers.Authorization = `Bearer ${cachedToken}`;
  return headers;
}

/**
 * Streams one turn. Yields {type: "delta", text} and {type: "tool", name} as
 * they arrive, so the caller decides how to render rather than being handed a
 * finished string.
 */
export async function* streamTurn(messages, signal, conversationId = null) {
  const res = await fetch(`${AGENT_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      model: MODEL_ID,
      messages,
      stream: true,
      // Pins the turn to a stored conversation so the server logs it there —
      // which is the entire mechanism behind surviving a restart.
      ...(conversationId ? { conversation_id: conversationId } : {}),
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Agent returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by a blank line.
    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      const { data, tool, widget, think, notice, context } = parseSseEvent(block);
      if (tool) yield { type: "tool", name: tool };
      if (widget) yield { type: "widget", widget };
      if (think !== null) yield { type: "think", chars: think };
      if (notice) yield { type: "notice", text: notice };
      if (context) yield { type: "context", ...context };
      if (!data) continue;
      if (data === "[DONE]") return;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        // Malformed frame -- skip it rather than killing the whole stream.
        continue;
      }

      const delta = parsed?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        yield { type: "delta", text: delta };
      }
    }
  }
}
