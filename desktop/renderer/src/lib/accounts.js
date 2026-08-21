/**
 * Google accounts, over the agent's API.
 *
 * Every call is a user act. No tool reaches these endpoints — the model asks
 * for an action and the harness attaches the token — so connecting, listing
 * and removing an account are things only a person does.
 *
 * Nothing here ever receives a token. The listing carries the address and
 * what was granted; the credential stays server-side.
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
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `${path} returned ${res.status}`);
  return body;
}

export const listAccounts = () => call("/accounts");

export const saveClient = (id, secret) =>
  call("/accounts/client", { method: "POST", body: JSON.stringify({ id, secret }) });

export const startConnect = (grants) =>
  call("/accounts/connect", { method: "POST", body: JSON.stringify({ grants }) });

export const connectStatus = (flowId) => call(`/accounts/connect/${flowId}`);

export const cancelConnect = (flowId) =>
  call(`/accounts/connect/${flowId}`, { method: "DELETE" }).catch(() => ({}));

export const removeAccount = (id) => call(`/accounts/${id}`, { method: "DELETE" });

/** The script enio ships, with this install's secret already in it. */
export const scriptSource = () => call("/accounts/script");

/** Hand back the deployment URL. The server calls it once before saving, so
 *  a URL that does not answer fails here rather than silently later. */
export const saveScript = (url, grants) =>
  call("/accounts/script", { method: "POST", body: JSON.stringify({ url, grants }) });

/** What each grant is called, and whether it changes anything.
 *  The server owns the list; these are only the words for it. */
export const GRANT_LABELS = {
  "mail.read": "Read mail",
  "mail.send": "Send mail",
  "calendar.read": "Read calendar",
  "calendar.write": "Add and change events",
  "drive.read": "Read Drive files",
  "drive.write": "Create and edit Drive files",
};
