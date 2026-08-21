import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Accounts: what enio is allowed to reach on the user's behalf.
 *
 * The decision behind this is in DECISIONS. In short: no passwords, ever --
 * a password is unscoped, bearer, unlocks changing every other credential,
 * and with MFA barely works alone anyway. OAuth instead, with the *user's
 * own* Google client, because Gmail and Calendar scopes are restricted and a
 * client id enio shipped would put every user behind an unverified-app
 * warning and a 100-test-user cap.
 *
 * The invariant this inherits, and the reason it is safe to have at all:
 * **credentials belong to the harness, never to the model.** The model asks
 * for an action; the harness attaches the token. Nothing here is reachable
 * from a tool, so a page the model reads cannot extract a token and a reply
 * cannot leak one.
 *
 * Accounts arrive read-only. Acting is a separate switch, because more
 * logged-in surface is more blast radius for the injection path
 * ENIO_BROWSER_ACT already documents, and granting both in one click would
 * make that the default.
 */

/** What an account may do, as a closed list. Scopes are derived from these,
 *  never chosen freely: a scope string is exactly the kind of detail that
 *  gets over-granted when it is typed rather than picked. */
export const GRANTS = {
  "mail.read": "https://www.googleapis.com/auth/gmail.readonly",
  // Send rather than modify: sending is what people want, and modify would
  // also permit deleting mail, which nothing here needs.
  "mail.send": "https://www.googleapis.com/auth/gmail.send",
  "calendar.read": "https://www.googleapis.com/auth/calendar.readonly",
  "calendar.write": "https://www.googleapis.com/auth/calendar.events",
  "drive.read": "https://www.googleapis.com/auth/drive.readonly",
  "drive.write": "https://www.googleapis.com/auth/drive.file",
} as const;

export type Grant = keyof typeof GRANTS;

/** The ones that only read. Everything else changes something on the user's
 *  account, which is what the acting switch gates. */
export const READ_GRANTS: Grant[] = ["mail.read", "calendar.read", "drive.read"];

export interface Account {
  id: string;
  provider: "google";
  /** The address the tokens belong to, so two accounts are tellable apart. */
  email: string;
  grants: Grant[];
  addedAt: number;
}

interface StoredAccount extends Account {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
}

interface AccountsFile {
  /** The user's own OAuth client, from their Google Cloud project. */
  client: { id: string; secret: string } | null;
  accounts: StoredAccount[];
}

const FILE = () => join(config.dataDir, "accounts.json");

function read(): AccountsFile {
  try {
    const parsed = JSON.parse(readFileSync(FILE(), "utf8")) as Partial<AccountsFile>;
    return { client: parsed.client ?? null, accounts: parsed.accounts ?? [] };
  } catch {
    return { client: null, accounts: [] };
  }
}

function write(data: AccountsFile): void {
  writeFileSync(FILE(), JSON.stringify(data, null, 2) + "\n");
  // Owner-only: this holds refresh tokens, which are long-lived credentials.
  try {
    chmodSync(FILE(), 0o600);
  } catch {
    /* A filesystem without modes still stores the account. */
  }
}

/** What a client can see: never a token, never the client secret. */
export function listAccounts(): Account[] {
  return read().accounts.map((a) => ({
    id: a.id,
    provider: a.provider,
    email: a.email,
    grants: a.grants,
    addedAt: a.addedAt,
  }));
}

export function hasClient(): boolean {
  const { client } = read();
  return Boolean(client?.id && client?.secret);
}

export function setClient(id: string, secret: string): void {
  const trimmedId = id.trim();
  const trimmedSecret = secret.trim();
  if (!trimmedId || !trimmedSecret) throw new Error("Both the client ID and secret are needed.");
  if (!trimmedId.endsWith(".apps.googleusercontent.com")) {
    // Caught here rather than at the consent screen, where the failure is a
    // Google error page with no hint about which field was wrong.
    throw new Error('That does not look like a Google client ID (it ends in ".apps.googleusercontent.com").');
  }
  write({ ...read(), client: { id: trimmedId, secret: trimmedSecret } });
}

export function removeAccount(id: string): boolean {
  const data = read();
  const before = data.accounts.length;
  data.accounts = data.accounts.filter((a) => a.id !== id);
  if (data.accounts.length === before) return false;
  write(data);
  return true;
}

/* ------------------------------------------------------- the consent flow */

/**
 * PKCE, because a desktop client's secret is not a secret.
 *
 * The verifier never leaves this process; only its hash goes to Google, so
 * an authorization code intercepted on the loopback redirect is useless to
 * anyone who does not also hold the verifier.
 */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface PendingConsent {
  /** Where the user has to go. The caller opens it; this never opens a
   *  browser itself, because the CLI and the desktop do that differently. */
  url: string;
  /** Resolves when Google redirects back, or rejects with a readable reason. */
  done: Promise<Account>;
  /** Give up waiting — closes the loopback listener. */
  cancel(): void;
}

/**
 * Start a consent flow and wait on the loopback redirect.
 *
 * Loopback rather than the retired out-of-band flow: Google turned OOB off,
 * and a local listener is also the only version where the code never has to
 * be copied by hand.
 */
export function beginConsent(grants: Grant[]): PendingConsent {
  const { client } = read();
  if (!client) throw new Error("Add your Google OAuth client first.");
  const wanted = [...new Set(grants)];
  if (wanted.length === 0) throw new Error("Pick at least one thing to allow.");
  for (const g of wanted) if (!(g in GRANTS)) throw new Error(`Unknown grant "${g}".`);

  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("base64url");

  let resolveDone: (a: Account) => void;
  let rejectDone: (e: Error) => void;
  const done = new Promise<Account>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/oauth") {
      res.writeHead(404).end();
      return;
    }
    const finish = (message: string) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><title>Enio</title>
<body style="font:16px system-ui;padding:3rem;max-width:34rem;margin:auto">
<h1 style="font-size:1.2rem">${message}</h1>
<p style="color:#666">You can close this tab and go back to Enio.</p>`);
    };
    // Google reports a refusal in the query string, not by failing to
    // redirect -- so a declined consent has to be read here or it hangs.
    const error = url.searchParams.get("error");
    if (error) {
      finish("Not connected.");
      close();
      rejectDone(new Error(error === "access_denied" ? "You declined the request." : error));
      return;
    }
    if (url.searchParams.get("state") !== state) {
      finish("Not connected.");
      close();
      rejectDone(new Error("The redirect did not match this request."));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      finish("Not connected.");
      close();
      rejectDone(new Error("Google sent no authorization code."));
      return;
    }
    finish("Connected.");
    close();
    exchange(code, verifier, client, redirectUri, wanted).then(resolveDone).catch(rejectDone);
  });

  const close = () => {
    try {
      server.close();
    } catch {
      /* already closed */
    }
  };

  server.listen(0, "127.0.0.1");
  const port = (server.address() as { port: number } | null)?.port ?? 0;
  const redirectUri = `http://127.0.0.1:${port}/oauth`;

  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", client.id);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", ["openid", "email", ...wanted.map((g) => GRANTS[g])].join(" "));
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("code_challenge_method", "S256");
  auth.searchParams.set("state", state);
  // Without these Google returns no refresh token on a repeat consent, and
  // the account silently stops working an hour later.
  auth.searchParams.set("access_type", "offline");
  auth.searchParams.set("prompt", "consent");

  return { url: auth.toString(), done, cancel: close };
}

async function exchange(
  code: string,
  verifier: string,
  client: { id: string; secret: string },
  redirectUri: string,
  grants: Grant[],
): Promise<Account> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.id,
      client_secret: client.secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google refused the exchange (${res.status}). ${detail.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };
  if (!body.refresh_token) {
    throw new Error("Google returned no refresh token — remove enio from your account's third-party access and try again.");
  }
  const data = read();
  const account: StoredAccount = {
    id: randomBytes(8).toString("hex"),
    provider: "google",
    email: emailFromIdToken(body.id_token) ?? "unknown",
    grants,
    addedAt: Date.now(),
    refreshToken: body.refresh_token,
    accessToken: body.access_token,
    expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
  };
  // Same address again means re-consenting, not a second account.
  data.accounts = [...data.accounts.filter((a) => a.email !== account.email), account];
  write(data);
  return {
    id: account.id,
    provider: account.provider,
    email: account.email,
    grants: account.grants,
    addedAt: account.addedAt,
  };
}

/** The address out of the id token. Read, not verified: it came straight
 *  from Google's token endpoint over TLS, and it is used as a label, never
 *  as an authorization decision. */
function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split(".")[1]!;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: string;
    };
    return json.email ?? null;
  } catch {
    return null;
  }
}

/**
 * A usable access token for an account, refreshing when it has expired.
 *
 * Exported for the *harness* to call when it acts on the user's behalf. No
 * tool imports this, which is the whole design: the model never holds a
 * credential, so nothing it reads or writes can carry one away.
 */
export async function accessTokenFor(accountId: string): Promise<string> {
  const data = read();
  const account = data.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error("No such account.");
  if (account.accessToken && account.expiresAt && account.expiresAt > Date.now() + 60_000) {
    return account.accessToken;
  }
  if (!data.client) throw new Error("The Google OAuth client is gone; re-add it.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: data.client.id,
      client_secret: data.client.secret,
      refresh_token: account.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Could not refresh ${account.email} (${res.status}). It may have been revoked at Google.`,
    );
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Google returned no access token.");
  account.accessToken = body.access_token;
  account.expiresAt = body.expires_in ? Date.now() + body.expires_in * 1000 : undefined;
  write(data);
  return body.access_token;
}

export { FILE as accountsFile };
