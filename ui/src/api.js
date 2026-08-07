// Thin fetch wrapper for the enio API. Every /api/* call needs the bearer
// token the backend injects into the served HTML as window.__ENIO_TOKEN__.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiFetch(path, options = {}) {
  const token = window.__ENIO_TOKEN__ || "";
  const headers = {
    Accept: "application/json",
    ...(options.headers || {}),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(path, { ...options, headers });
  } catch (networkErr) {
    throw new ApiError(
      `Could not reach the enio server (${networkErr.message}). Is it running?`,
      0
    );
  }

  if (res.status === 401) {
    throw new ApiError(
      "Not authorized. The session token is missing or invalid — reload the page from the enio server.",
      401
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.text();
      detail = body ? `: ${body.slice(0, 300)}` : "";
    } catch {
      // ignore — best-effort detail
    }
    throw new ApiError(`Request to ${path} failed (${res.status})${detail}`, res.status);
  }

  if (res.status === 204) return null;

  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(`Server returned invalid JSON from ${path}`, res.status);
  }
}
