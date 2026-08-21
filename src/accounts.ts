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
 * and with MFA barely works alone anyway. OAuth instead.
 *
 * Whose OAuth client is a *publishing* question, not a technical one, and
 * both answers are supported. A client enio ships gives every user one
 * click, and costs Google verification plus an annual CASA assessment
 * because Gmail's read scope is restricted. Until that exists, a user brings
 * their own client and is their own test user. See BUNDLED below.
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
  /** "google" is OAuth with a registered client; "appsscript" is a script
   *  the user deployed into their own account, which needs no client at
   *  all. Same concept, different plumbing. */
  provider: "google" | "appsscript";
  /** The address the tokens belong to, so two accounts are tellable apart. */
  email: string;
  grants: Grant[];
  addedAt: number;
}

interface StoredAccount extends Account {
  /** OAuth accounts. */
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  /** Apps Script accounts: the deployment and the secret that authorizes a
   *  call to it. Both are credentials and neither is ever returned. */
  scriptUrl?: string;
  scriptSecret?: string;
  scriptVersion?: number;
}

interface AccountsFile {
  /** The user's own OAuth client, from their Google Cloud project. */
  client: { id: string; secret: string } | null;
  accounts: StoredAccount[];
  /** The secret baked into the next script the user deploys. */
  pendingScriptSecret?: string;
}

const FILE = () => join(config.dataDir, "accounts.json");

/**
 * A client enio itself ships, if there is one.
 *
 * "Sign in with Google" is not a different mechanism from bring-your-own --
 * it is the same flow with the publisher's client id instead of the user's.
 * What stands between the two is verification, not code: Gmail's read scope
 * is *restricted*, so publishing one means Google review plus a CASA security
 * assessment renewed every twelve months. (Enio's own shape helps: CASA's
 * expensive tiers key on storing or transmitting that data on servers, and
 * nothing here leaves the machine.)
 *
 * So both paths exist and the code does not care which is in play. Set these
 * and every user gets one click; leave them unset and the panel asks for
 * their own client. Flipping between the two is a build constant, never a
 * rewrite.
 */
const BUNDLED = {
  id: process.env.ENIO_GOOGLE_CLIENT_ID ?? "",
  secret: process.env.ENIO_GOOGLE_CLIENT_SECRET ?? "",
};

/** Where the client in use came from, so the panel can say "Sign in with
 *  Google" instead of walking someone through Google Cloud Console. */
export function clientSource(): "bundled" | "user" | null {
  const { client } = read();
  if (client?.id && client?.secret) return "user";
  return BUNDLED.id && BUNDLED.secret ? "bundled" : null;
}

/** The client a flow should use: the user's own wins, because someone who
 *  went to the trouble of registering one meant to use it. */
function activeClient(): { id: string; secret: string } | null {
  const { client } = read();
  if (client?.id && client?.secret) return client;
  return BUNDLED.id && BUNDLED.secret ? { ...BUNDLED } : null;
}

function read(): AccountsFile {
  try {
    const parsed = JSON.parse(readFileSync(FILE(), "utf8")) as Partial<AccountsFile>;
    return {
      client: parsed.client ?? null,
      accounts: parsed.accounts ?? [],
      pendingScriptSecret: parsed.pendingScriptSecret,
    };
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
  return activeClient() !== null;
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

/**
 * Record a deployed script as an account.
 *
 * The grants are what the script can do rather than what Google was asked
 * for -- with a script there is no scope list, the code IS the scope, so
 * this records the capability the deployment actually has.
 */
export function addScriptAccount(input: {
  email: string;
  url: string;
  secret: string;
  version: number;
  grants: Grant[];
}): Account {
  const data = read();
  const account: StoredAccount = {
    id: randomBytes(8).toString("hex"),
    provider: "appsscript",
    email: input.email,
    grants: input.grants,
    addedAt: Date.now(),
    scriptUrl: input.url,
    scriptSecret: input.secret,
    scriptVersion: input.version,
  };
  // Re-deploying replaces rather than doubles: the same address behind a new
  // URL is the same account with a new door.
  data.accounts = [...data.accounts.filter((a) => a.email !== input.email), account];
  write(data);
  return {
    id: account.id,
    provider: account.provider,
    email: account.email,
    grants: account.grants,
    addedAt: account.addedAt,
  };
}

/** The deployment behind a script account, for the harness only. No tool
 *  imports this -- same rule as accessTokenFor. */
export function scriptFor(accountId: string): { url: string; secret: string; version: number } | null {
  const account = read().accounts.find((a) => a.id === accountId);
  if (!account?.scriptUrl || !account.scriptSecret) return null;
  return {
    url: account.scriptUrl,
    secret: account.scriptSecret,
    version: account.scriptVersion ?? 0,
  };
}

/**
 * The secret for the next script deployment, persisted rather than held in
 * memory. The in-memory version broke on the very first real use: the user
 * copied the code, enio restarted before they pasted the URL back, and the
 * new process minted a fresh secret -- so the deployed script answered
 * "unauthorized" with every visible setting correct. A credential the user
 * has already deployed must survive a restart.
 */
export function pendingScriptSecret(): string {
  const data = read();
  if (data.pendingScriptSecret) return data.pendingScriptSecret;
  const secret = randomBytes(24).toString("base64url");
  write({ ...data, pendingScriptSecret: secret });
  return secret;
}

/** Consumed on a successful connect: the secret now lives on the account. */
export function clearPendingScriptSecret(): void {
  const data = read();
  if (!data.pendingScriptSecret) return;
  delete data.pendingScriptSecret;
  write(data);
}

/**
 * Upgrade support: the secret of an already-connected script account.
 *
 * Without this, re-copying the code for a new script version minted a fresh
 * pending secret -- so upgrading orphaned the working deployment, and the
 * user had to reconnect from scratch. Handing out source with the EXISTING
 * secret means an upgrade is: replace the file, deploy a new version, done.
 * Same URL, same secret, more operations.
 */
export function scriptUpgradeSecret(): string | null {
  const account = read().accounts.find((a) => a.provider === "appsscript" && a.scriptSecret);
  return account?.scriptSecret ?? null;
}

/** A script account matched by its deployment URL, for re-connects. */
export function scriptAccountByUrl(url: string): { id: string; secret: string } | null {
  const account = read().accounts.find((a) => a.scriptUrl === url && a.scriptSecret);
  return account ? { id: account.id, secret: account.scriptSecret! } : null;
}

/** Recorded after a successful re-connect against an upgraded deployment. */
export function updateScriptVersion(id: string, version: number): void {
  const data = read();
  const account = data.accounts.find((a) => a.id === id);
  if (!account) return;
  account.scriptVersion = version;
  write(data);
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
  const client = activeClient();
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
  if (!account.refreshToken) throw new Error("That account is a script, not an OAuth grant.");
  if (account.accessToken && account.expiresAt && account.expiresAt > Date.now() + 60_000) {
    return account.accessToken;
  }
  const client = activeClient();
  if (!client) throw new Error("The Google OAuth client is gone; re-add it.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
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
