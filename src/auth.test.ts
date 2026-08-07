import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

const scratch = mkdtempSync(join(tmpdir(), "maple-auth-"));
process.env.MAPLE_DATA_DIR = join(scratch, "data");
process.env.MAPLE_WORKSPACE = join(scratch, "workspace");

const { ensureToken, readToken, extractToken, isAuthorized } = await import("./auth.js");

after(() => rmSync(scratch, { recursive: true, force: true }));

/** Minimal stand-in for an http request — only headers are read. */
const req = (headers: Record<string, string>) =>
  ({ headers } as unknown as IncomingMessage);

describe("token generation", () => {
  test("creates a long random token", () => {
    const token = ensureToken();
    assert.ok(token.length >= 40, `token too short: ${token.length}`);
    assert.match(token, /^[A-Za-z0-9_-]+$/, "should be base64url");
  });

  test("is stable across calls", () => {
    assert.equal(ensureToken(), ensureToken());
  });

  test("is readable back from disk", () => {
    assert.equal(readToken(), ensureToken());
  });

  test("is written owner-only", () => {
    ensureToken();
    const mode = statSync(join(process.env.MAPLE_DATA_DIR!, "token")).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });

  test("the file has no other content", () => {
    const raw = readFileSync(join(process.env.MAPLE_DATA_DIR!, "token"), "utf8");
    assert.equal(raw.trim(), ensureToken());
  });
});

describe("token extraction", () => {
  test("reads a bearer header", () => {
    assert.equal(extractToken(req({ authorization: "Bearer abc123" })), "abc123");
  });

  test("is case-insensitive on the scheme", () => {
    assert.equal(extractToken(req({ authorization: "bearer abc123" })), "abc123");
  });

  test("tolerates extra whitespace", () => {
    assert.equal(extractToken(req({ authorization: "Bearer   abc123  " })), "abc123");
  });

  test("reads x-api-key as an alternative", () => {
    assert.equal(extractToken(req({ "x-api-key": "abc123" })), "abc123");
  });

  test("returns null when absent or malformed", () => {
    assert.equal(extractToken(req({})), null);
    assert.equal(extractToken(req({ authorization: "Basic dXNlcjpwYXNz" })), null);
    assert.equal(extractToken(req({ authorization: "Bearer" })), null);
    assert.equal(extractToken(req({ "x-api-key": "   " })), null);
  });
});

describe("authorization", () => {
  const secret = ensureToken();

  test("accepts the correct token", () => {
    assert.equal(isAuthorized(req({ authorization: `Bearer ${secret}` }), secret), true);
  });

  test("rejects a wrong token of identical length", () => {
    // Same length matters: it's the case that reaches the constant-time compare
    // rather than short-circuiting on length.
    const wrong = "x".repeat(secret.length);
    assert.equal(isAuthorized(req({ authorization: `Bearer ${wrong}` }), secret), false);
  });

  test("rejects a token differing only in the last character", () => {
    const almost = secret.slice(0, -1) + (secret.endsWith("a") ? "b" : "a");
    assert.equal(isAuthorized(req({ authorization: `Bearer ${almost}` }), secret), false);
  });

  test("rejects a prefix of the real token", () => {
    assert.equal(
      isAuthorized(req({ authorization: `Bearer ${secret.slice(0, 10)}` }), secret),
      false,
    );
  });

  test("rejects an empty request", () => {
    assert.equal(isAuthorized(req({}), secret), false);
  });

  test("does not throw on absurd input", () => {
    assert.equal(isAuthorized(req({ authorization: "Bearer " + "z".repeat(10000) }), secret), false);
  });
});
