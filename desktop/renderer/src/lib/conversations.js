/**
 * Stored conversations, over the agent's API.
 *
 * The thread on screen is React state; every message is also logged by the
 * server. These calls are what turn that log back into a thread after a
 * restart, and what makes discarding a deliberate act with a named cost.
 */

const AGENT_BASE = "http://127.0.0.1:8787";

async function call(path, init = {}) {
  const token = await window.maple?.getToken();
  const res = await fetch(`${AGENT_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // The server's refusal prose (caps, unattachable roots) is the message.
    throw new Error(body?.error?.message ?? `${path} returned ${res.status}`);
  }
  return res.json();
}

export const listConversations = () => call("/conversations").then((d) => d.conversations);

export const createConversation = () =>
  call("/conversations", { method: "POST" }).then((d) => d.id);

export const conversationMessages = (id) =>
  call(`/conversations/${id}/messages`).then((d) => d.messages);

/** The facts that die with this conversation unless kept. */
export const conversationKnowledge = (id) =>
  call(`/conversations/${id}/knowledge`).then((d) => d.facts);

/** Standing attachments scoped to this conversation — folders and files the
 *  agent may read for as long as the thread lives. */
export const conversationAttachments = (id) =>
  call(`/conversations/${id}/attachments`).then((d) => d.attachments);

export const attachToConversation = (id, path, note = "") =>
  call(`/conversations/${id}/attachments`, {
    method: "POST",
    body: JSON.stringify({ path, note }),
  }).then((d) => d.attachment);

export const detachFromConversation = (id, alias) =>
  call(`/conversations/${id}/attachments/${encodeURIComponent(alias)}`, { method: "DELETE" });

export const discardConversation = (id, { keepFacts }) =>
  call(`/conversations/${id}?facts=${keepFacts ? "keep" : "forget"}`, {
    method: "DELETE",
  });

/** Plans still waiting on a decision — the approval cards to re-draw after a
 *  restart, since the widget only ever travelled over the live stream. */
export const pendingPlans = () => call("/plans/pending").then((d) => d.plans);

/** What the OS currently allows. Re-probed server-side on every call, so this
 *  is how a grant made in System Settings gets noticed without a restart. */
export const permissions = () => call("/permissions");
