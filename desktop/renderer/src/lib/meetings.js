/**
 * Meeting capture, over the agent's API.
 *
 * The server owns the pipeline; this file is transport. Poll-shaped like the
 * model download client: a meeting runs for minutes and outlives any single
 * request, so state is a GET, not a stream.
 */

const AGENT_BASE = "http://127.0.0.1:8787";

async function authHeaders(extra = {}) {
  const token = await window.maple?.getToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

async function call(path, init = {}) {
  const res = await fetch(`${AGENT_BASE}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `${path} returned ${res.status}`);
  return body;
}

export const startMeeting = async (topic) =>
  call("/meetings/start", {
    method: "POST",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(topic ? { topic } : {}),
  }).then((d) => d.meeting);

/** One retry, then drop: the server marks the gap as [audio missing], which
 *  is more honest than blocking the recording on a flaky localhost hop. */
export const sendSegment = async (wav, seq) => {
  const post = async () =>
    call(`/meetings/segment?seq=${seq}`, {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "audio/wav" }),
      body: wav,
    });
  try {
    return (await post()).meeting;
  } catch {
    try {
      return (await post()).meeting;
    } catch {
      return null;
    }
  }
};

export const stopMeeting = async () =>
  call("/meetings/stop", { method: "POST", headers: await authHeaders() }).then((d) => d.meeting);

export const meetingState = async () =>
  call("/meetings", { headers: await authHeaders() }).then((d) => d.meeting);

export const cancelMeeting = async () =>
  call("/meetings", { method: "DELETE", headers: await authHeaders() }).then((d) => d.cancelled);
