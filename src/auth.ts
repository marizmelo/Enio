import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IncomingMessage } from "node:http";
import { config } from "./config.js";

/**
 * Bearer-token auth for the HTTP endpoint.
 *
 * Why this exists even though the server binds to loopback: a web page you have
 * open can issue requests to 127.0.0.1. Origin checks help but are not a
 * boundary — no-cors form posts and DNS rebinding both get around them. The
 * only thing that actually gates access is a secret the caller must present.
 *
 * That matters more here than in most local servers, because the agent behind
 * this endpoint can run shell commands. An unauthenticated `/v1/chat/completions`
 * is remote code execution wearing a chat interface.
 */

const tokenPath = () => join(config.dataDir, "token");

/** 32 bytes of CSPRNG output, base64url. Generated once and reused. */
export function ensureToken(): string {
  const path = tokenPath();
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
  }

  const token = randomBytes(32).toString("base64url");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token + "\n", { mode: 0o600 });
  // writeFileSync's mode is ignored when the file already exists, so set it.
  chmodSync(path, 0o600);
  return token;
}

export function readToken(): string | null {
  const path = tokenPath();
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf8").trim();
  return value.length >= 32 ? value : null;
}

/** Constant-time compare, guarded for length so it can't throw. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Accepts the token as `Authorization: Bearer <token>` — what every
 * OpenAI-compatible client already sends for its API key, so existing tools
 * work by pasting the token into their "API key" field — or as `X-API-Key`
 * for clients that don't have an API key field at all.
 */
export function extractToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return null;
}

export function isAuthorized(req: IncomingMessage, expected: string): boolean {
  const provided = extractToken(req);
  if (!provided) return false;
  return tokensMatch(provided, expected);
}
