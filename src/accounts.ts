import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { getDb } from "./memory/db.js";

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

/**
 * The reads a "my" or "your" in the person's message may steer: mail and
 * the calendar. Both say whose account they read in every result. Drive,
 * todos and contacts do not, and a steered read nobody can see is worse
 * than one that was not steered.
 */
function steered(grant: Grant | null): boolean {
  return grant === "mail.read" || grant === "calendar.read";
}

/**
 * Whose account it is. Two different jobs that must never be confused in a
 * reply: the agent's OWN account is its identity (the address it sends
 * from, the calendar it can be invited to); a USER account is delegated
 * access to the person's mail and calendar in their name. Watched happen:
 * with only the agent's Gmail connected, "check my email" read it and the
 * reply said "your inbox" — one old message, and the person doubted it
 * was real. Unset means connected before this existed; the panel asks.
 */
export type AccountOwner = "agent" | "user";

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
  owner?: AccountOwner;
  /** How the person refers to it: "work", "personal", "Enio's". */
  label?: string;
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
  /** The account a conversation uses when it has not chosen one. */
  defaultAccount?: string | null;
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
      defaultAccount: parsed.defaultAccount ?? null,
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

const publicView = (a: StoredAccount): Account => ({
  id: a.id,
  provider: a.provider,
  email: a.email,
  grants: a.grants,
  addedAt: a.addedAt,
  ...(a.owner ? { owner: a.owner } : {}),
  ...(a.label ? { label: a.label } : {}),
});

/** What a client can see: never a token, never the client secret. */
export function listAccounts(): Account[] {
  return read().accounts.map(publicView);
}

/** How an account is named in a reply or a notice: who it belongs to, then
 *  the label or address. The owner word is the whole point — "your inbox"
 *  about the agent's own account is the sentence this exists to prevent. */
export function describeAccount(a: Pick<Account, "email" | "owner" | "label">): string {
  const name = a.label ? `${a.label} (${a.email})` : a.email;
  if (a.owner === "agent") return `Enio's own account ${name}`;
  if (a.owner === "user") return `your account ${name}`;
  return `account ${name} (owner not set — mark it in Connections)`;
}

/** The same, in the agent's own voice: what a tool result says to the model,
 *  which IS Enio. "Enio's own calendar has no events" in a reply treats Enio
 *  as someone else; the model repeats the tool's wording, so the tool says
 *  "my own account" and the reply comes out in the first person. Notices
 *  keep describeAccount: they are the window speaking about Enio. */
export function spokenAccount(a: Pick<Account, "email" | "owner" | "label">): string {
  const name = a.label ? `${a.label} (${a.email})` : a.email;
  // No label on the agent's own: it is usually "Enio's", and "my own account
  // Enio's" is the third person creeping back in.
  if (a.owner === "agent") return `my own account (${a.email})`;
  if (a.owner === "user") return `your account ${name}`;
  return `account ${name} (owner not set)`;
}

export function setAccountOwner(id: string, owner: AccountOwner, label?: string): Account | null {
  if (owner !== "agent" && owner !== "user") throw new Error('Owner is "agent" or "user".');
  const data = read();
  const account = data.accounts.find((a) => a.id === id);
  if (!account) return null;
  account.owner = owner;
  if (label !== undefined) {
    const clean = label.trim().slice(0, 40);
    if (clean) account.label = clean;
    else delete account.label;
  }
  write(data);
  return publicView(account);
}

export function defaultAccountId(): string | null {
  const data = read();
  const id = data.defaultAccount ?? null;
  return id && data.accounts.some((a) => a.id === id) ? id : null;
}

export function setDefaultAccount(id: string | null): void {
  const data = read();
  if (id && !data.accounts.some((a) => a.id === id)) throw new Error("No such account.");
  data.defaultAccount = id;
  write(data);
}

/**
 * The account this turn means, set by the turn loop from the conversation's
 * choice before any tool runs. Harness state, like the memory session: a
 * tool asks for "the account" and gets the one the person picked, never
 * one the model picked. Null means no choice — the resolver falls back to
 * the machine default, then to owner preference.
 */
/**
 * What a turn holds about accounts: the account in use, the one a step is
 * set to, whose mailbox the person asked for, their message, and which
 * mailboxes were read.
 *
 * Kept per turn, in the async context the turn runs in (inTurn), and not
 * in variables of this module. They were module variables first, saved
 * and put back around each turn, and that holds only while turns do not
 * overlap. They do: a chat turn and a step of a scheduled automation run
 * in one process. Review ran exactly that: the chat turn ended while the
 * step was waiting on the model, put back the values it had found, and
 * the step's next call read the person's mailbox where it was set to
 * Enio's. With a store per turn there is nothing to put back and nothing
 * of another turn's to find.
 *
 * Outside any turn (a tool called directly, a test) there is one state
 * of its own, which is what these setters and readers then use.
 */
interface TurnState {
  active: string | null;
  pinned: string | null;
  asked: AccountOwner | null;
  message: string | null;
  /** The same message, unfolded. */
  said: string | null;
  nameRefused: boolean;
  mailReads: Array<AccountOwner | undefined>;
}
const freshTurn = (): TurnState => ({ active: null, pinned: null, asked: null, message: null, said: null, nameRefused: false, mailReads: [] });
const outsideAnyTurn = freshTurn();
const turns = new AsyncLocalStorage<TurnState>();
const turn = (): TurnState => turns.getStore() ?? outsideAnyTurn;
/** Run a turn with account state of its own. A turn started inside
 *  another (a step run by run_pipeline) gets its own again, and the outer
 *  one's is as it left it. */
export function inTurn<T>(run: () => Promise<T>): Promise<T> {
  return turns.run(freshTurn(), run);
}

export function setActiveAccount(id: string | null): void {
  turn().active = id;
}
export function activeAccount(): string | null {
  return turn().active;
}

/**
 * The account a step of an automation is set to, for the length of that
 * step's turn. Stronger than the conversation's choice in two ways, and
 * both are what make it a setting and not a hint:
 *
 * - Nothing else chooses. A name at the start of the step's prompt does
 *   not switch, and an account the MODEL names in a tool call is dropped
 *   (personNamed): the person picked from a list, once, and a step that
 *   reads another mailbox because its prompt happened to open "check the
 *   work inbox" is a setting that does not hold.
 * - Nothing stands in. When the account lacks what a tool needs, the tool
 *   has no account (pickAccount returns null) and says so. Falling
 *   through to the default is right in a conversation, where the reply
 *   names the account and somebody is reading; unattended, it is mail
 *   sent from an address nobody chose.
 */
export function setPinnedAccount(id: string | null): void {
  turn().pinned = id;
}
export function pinnedAccountNow(): string | null {
  return turn().pinned;
}

/** What a step may store: an owner, resolved when the step runs, or one
 *  connected account by id. A closed shape, checked on save. */
export const STEP_ACCOUNT = /^(?:agent|user|[0-9a-f]{8,32})$/;

const GRANT_WORDS: Record<Grant, string> = {
  "mail.read": "permission to read mail",
  "mail.send": "permission to send mail",
  "calendar.read": "permission to read the calendar",
  "calendar.write": "permission to change the calendar",
  "drive.read": "permission to read Drive",
  "drive.write": "permission to write to Drive",
};

/**
 * A step's setting from what someone typed at the command line: an owner
 * word, or the name of a connected account. Null when it names nothing.
 * An account's own label is looked for first, so one labelled "mine" is
 * that account and not the owner.
 */
export function stepAccountFor(word: string): string | null {
  const w = word.trim().toLowerCase().replace(/[\u2018\u2019\u02BC]/g, "'");
  if (!w) return null;
  const labelled = read().accounts.filter((a) => (a.label ?? "").toLowerCase() === w);
  if (labelled.length === 1) return labelled[0]!.id;
  if (/^(?:enio|enio's|agent|agent's|its own|own)$/.test(w)) return "agent";
  if (/^(?:mine|my|me|my own|user|user's)$/.test(w)) return "user";
  return findAccountByName(word)?.id ?? null;
}

/**
 * The connected account a step's choice means right now.
 *
 * "agent" and "user" are resolved here, at run time, and not stored as an
 * id: accounts are connected and removed independently of automations,
 * and "mine" should keep meaning the person's account after they replace
 * it. An id that is gone, an owner with no account, or an account without
 * the grant the step is for is a reason the step cannot run, said in
 * words a person can act on. Never another account in its place.
 */
export function stepAccount(
  value: string,
  grant: Grant | null,
): { ok: true; account: Account } | { ok: false; reason: string } {
  const fix = " Choose another account for this step, or connect one in Connections.";
  const usable = read().accounts.filter((a) => a.provider === "appsscript" && a.scriptUrl && a.scriptSecret);
  const holds = (a: StoredAccount) => grant === null || a.grants.includes(grant);
  let candidates: StoredAccount[];
  let whose: string;
  if (value === "agent") {
    candidates = usable.filter((a) => a.owner === "agent");
    whose = "Enio's own account";
  } else if (value === "user") {
    const dflt = defaultAccountId();
    const rank = (a: StoredAccount) => (a.id === dflt ? 0 : a.owner === "user" ? 1 : 2);
    candidates = usable.filter((a) => a.owner !== "agent").sort((a, b) => rank(a) - rank(b));
    whose = "your account";
  } else {
    candidates = usable.filter((a) => a.id === value);
    whose = "an account that is no longer connected";
    if (candidates.length === 0) return { ok: false, reason: `This step is set to use ${whose}.${fix}` };
  }
  if (candidates.length === 0) {
    return { ok: false, reason: `This step is set to use ${whose}, and ${value === "agent" ? "none is" : "none of yours is"} connected.${fix}` };
  }
  const chosen = candidates.find(holds);
  if (!chosen) {
    return {
      ok: false,
      reason: `This step is set to use ${describeAccount(candidates[0]!)}, which is connected without ${GRANT_WORDS[grant!]}.${fix}`,
    };
  }
  return { ok: true, account: publicView(chosen) };
}

/**
 * Find an account by what a person calls it: label, address, or the
 * owner word ("mine", "yours", "enio's"). Closed list, case-insensitive,
 * substring on label and address; the first unambiguous match wins. Used
 * for the `account` tool parameter and for "use my work email" in chat.
 */
export function findAccountByName(name: string): Account | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const all = listAccounts();
  // A label that IS the word comes first: "personal" is an owner word and
  // also what people call an account, and with two of the person's accounts
  // connected the owner word alone returned whichever was listed first.
  const exact = all.filter((a) => (a.label ?? "").toLowerCase() === q);
  if (exact.length === 1) return exact[0]!;
  const owner = ownerWord(q);
  if (owner) return all.find((a) => a.owner === owner) ?? null;
  const hits = all.filter(
    (a) => a.email.toLowerCase().includes(q) || (a.label ?? "").toLowerCase().includes(q) || a.id === q,
  );
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * Which account a tool should use. In order: the conversation's choice,
 * the machine default, then by owner for the kind of act — reading means
 * the person's own account, so a user account first; sending means the
 * agent's identity, so the agent's first; accounts whose owner is not set
 * sit between. Each step is skipped when that account lacks the grant.
 */
function pickAccount(grant: Grant | null, prefer: AccountOwner): StoredAccount | null {
  const usable = read().accounts.filter(
    (a) => a.provider === "appsscript" && a.scriptUrl && a.scriptSecret && (grant === null || a.grants.includes(grant)),
  );
  if (usable.length === 0) return null;
  // A step set to one account uses it or nothing (setPinnedAccount).
  if (turn().pinned) return usable.find((a) => a.id === turn().pinned) ?? null;
  // The person said whose, this turn: "check your email", "what's on my
  // calendar". It outranks the conversation's choice for READING mail and
  // the calendar, and for this turn only. Reading, because the words are read by a grammar and a
  // grammar is sometimes wrong: a wrong read costs one look in the other
  // mailbox, named as such, where a wrong send or a wrong calendar entry
  // would not be taken back. This turn, because kept on the conversation
  // it carried every later call along with it, sends included.
  if (turn().asked && steered(grant)) {
    // An account whose owner was never set may be the person's, as it is
    // everywhere else here; it is never Enio's by guess.
    const theirs = usable.filter((a) => (turn().asked === "agent" ? a.owner === "agent" : a.owner !== "agent"));
    if (theirs.length > 0) {
      const dfltId = defaultAccountId();
      return (
        theirs.find((a) => a.id === turn().active) ??
        theirs.find((a) => a.id === dfltId) ??
        // Marked theirs before one that might be.
        theirs.find((a) => a.owner === turn().asked) ??
        theirs[0]!
      );
    }
  }
  const chosen = turn().active ? usable.find((a) => a.id === turn().active) : undefined;
  if (chosen) return chosen;
  const dflt = defaultAccountId();
  const byDefault = dflt ? usable.find((a) => a.id === dflt) : undefined;
  if (byDefault) return byDefault;
  const rank = (a: StoredAccount) => (a.owner === prefer ? 0 : a.owner === undefined ? 1 : 2);
  return [...usable].sort((a, b) => rank(a) - rank(b))[0]!;
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
  owner?: AccountOwner;
  label?: string;
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
    ...(input.owner ? { owner: input.owner } : {}),
    ...(input.label?.trim() ? { label: input.label.trim().slice(0, 40) } : {}),
  };
  // Re-deploying replaces rather than doubles: the same address behind a new
  // URL is the same account with a new door.
  data.accounts = [...data.accounts.filter((a) => a.email !== input.email), account];
  write(data);
  return publicView(account);
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

/**
 * The account mail should flow through, if any.
 *
 * For the HARNESS: the mail tools call this to decide backend and to fetch
 * the deployment, and the model sees only the results. Split by kind because
 * reading and sending are separate grants -- an account connected read-only
 * must never be a send path, which is the recorded read/act line enforced at
 * the call site rather than in a prompt.
 */
export interface PickedAccount {
  id: string;
  email: string;
  url: string;
  secret: string;
  owner?: AccountOwner;
  label?: string;
  /** describeAccount(): the window's voice, for notices. */
  described: string;
  /** spokenAccount(): the agent's own voice, for tool results the model repeats. */
  spoken: string;
}

const picked = (a: StoredAccount): PickedAccount => ({
  id: a.id,
  email: a.email,
  url: a.scriptUrl!,
  secret: a.scriptSecret!,
  ...(a.owner ? { owner: a.owner } : {}),
  ...(a.label ? { label: a.label } : {}),
  described: describeAccount(a),
  spoken: spokenAccount(a),
});

export function scriptMailAccount(kind: "read" | "send"): PickedAccount | null {
  const grant: Grant = kind === "read" ? "mail.read" : "mail.send";
  const account = pickAccount(grant, kind === "read" ? "user" : "agent");
  if (!account) return null;
  // Reading falls back to anything but the agent's own account. "Check my
  // email" against Enio's inbox, presented as the person's, was the live
  // failure the owner model exists for; the agent's mail is read when the
  // person chose it (conversation or default) or named it, never by
  // fallback. Sending is the opposite: the agent's address IS the default.
  if (kind === "read" && account.owner === "agent" && !turn().active && !defaultAccountId() && turn().asked !== "agent") return null;
  return picked(account);
}

/** Whether any connected account can read mail at all — the question the
 *  tool registry asks. Whose it is decides what a call does, not whether
 *  the tool exists: withholding search_email because only Enio's own
 *  account was connected left the mail agent calling a tool it did not
 *  hold. */
export function anyMailReadAccount(): boolean {
  return read().accounts.some((a) => a.provider === "appsscript" && a.scriptUrl && a.scriptSecret && a.grants.includes("mail.read"));
}

/** When reading found nothing of the person's: the agent's own account, if
 *  that is what is connected, so the tool can say so instead of reading it
 *  or claiming nothing is connected. */
export function agentOnlyMailAccount(): PickedAccount | null {
  // Enio's own never stands in for the account a step is set to.
  if (turn().pinned) return null;
  const a = read().accounts.find(
    (x) => x.owner === "agent" && x.provider === "appsscript" && x.scriptUrl && x.scriptSecret && x.grants.includes("mail.read"),
  );
  return a ? picked(a) : null;
}

/**
 * The connected script account, optionally requiring a grant.
 *
 * The generalisation of scriptMailAccount for the rest of the account's
 * life: calendar, todos, contacts, documents. Same rules -- harness-only,
 * the model sees results and never a credential, and a write grant absent
 * means the acting tool is WITHHELD rather than offered-and-refused, since a
 * dead-end tool burns the model's limited attention.
 */
/** A specific account by id, when a tool was told which one — still only
 *  with the grant the act needs. */
export function scriptAccountById(id: string, grant: Grant | null): PickedAccount | null {
  const a = read().accounts.find(
    (x) => x.id === id && x.provider === "appsscript" && x.scriptUrl && x.scriptSecret && (grant === null || x.grants.includes(grant)),
  );
  return a ? picked(a) : null;
}

/** The account a conversation chose, if any and if it still exists. */
export function conversationAccount(sessionId: string): string | null {
  try {
    const row = getDb().prepare(`SELECT account_id AS id FROM sessions WHERE id = ?`).get(sessionId) as { id: string | null } | undefined;
    const id = row?.id ?? null;
    return id && read().accounts.some((a) => a.id === id) ? id : null;
  } catch {
    return null;
  }
}

export function setConversationAccount(sessionId: string, id: string | null): void {
  if (id && !read().accounts.some((a) => a.id === id)) throw new Error("No such account.");
  getDb().prepare(`UPDATE sessions SET account_id = ? WHERE id = ?`).run(id, sessionId);
}

/**
 * "use my work email", "switch to enio's account", "check my personal
 * inbox": the name the person used, or null. A closed shape on purpose —
 * the switch is the person's act, resolved against the connected list by
 * findAccountByName, never a model decision.
 */
export function accountSwitchRequest(text: string): string | null {
  const m = /^\s*(?:please\s+)?(?:use|switch to|check|read|open|look in)\s+(?:my\s+|the\s+)?(.+?)\s+(?:account|e-?mail|mail|inbox|gmail|calendar)\b/i.exec(
    text.replace(/[‘’ʼ]/g, "'"),
  );
  if (!m) return null;
  const name = m[1]!.trim();
  // "check my email" is a request, not a switch: a bare possessive or
  // article names nothing. The first version answered it with "no account
  // called my". "own" belongs with them: "use my own account" is the
  // person's, and read as a name it reached ownerWord, which took it for
  // Enio's. Whose a possessive means is ownerAsked's question.
  //
  // The name is otherwise taken as written, long and odd ones included.
  // This choice is STORED, and sends follow it, so it is not second-guessed:
  // a version that stripped "function words" out of names stored "work"
  // for an account labelled "old work". A phrase that is no name matches
  // no account and stores nothing; whether to say so is the caller's
  // (explicitSwitch).
  if (/^(?:my|the|your|you're|youre|ur|this|that|our|a|an|me|its|his|her|their|all|any|own|my own|your own|mine|yours)$/i.test(name)) return null;
  return name;
}

/**
 * Whether a name that matched no account is worth telling the person
 * about: behind "use" or "switch to", and short. "Look in my documents
 * folder for the calendar export" has the shape of a name before a noun
 * too, and the reply came with a notice that no account called "documents
 * folder for the" was connected.
 */
export function explicitSwitch(text: string, name: string): boolean {
  return /^\s*(?:please\s+)?(?:use|switch\s+to)\b/i.test(text) && name.split(/\s+/).length <= 3 && !/[,;:"]/.test(name);
}

/** Whether a name is an owner word rather than a label: "mine", "user's",
 *  "enio's". Such a name with no matching account is a fact to report, not
 *  a typo to refuse. */
export function ownerWord(name: string): AccountOwner | null {
  const q = name.trim().toLowerCase();
  if (/^(enio'?s?|(?:the )?agent'?s?)$/.test(q)) return "agent";
  if (/^(mine|my|me|personal|user'?s?|the user'?s?|user)$/.test(q)) return "user";
  return null;
}

/**
 * A word whose owner depends on who is speaking.
 *
 * The `account` tool argument is written by the model. "my" there is the
 * person's when the model copied their message and Enio's when it spoke for
 * itself -- its own account reaches it as "my own account" -- and nothing in
 * the argument says which. "your" is the same word from the other side. So
 * a first- or second-person word in that argument names nothing: the person's
 * own words were already read where they are unambiguous (ownerAsked).
 */
export function speakerRelative(name: string): boolean {
  return /^(?:my|mine|me|my own|own|its own|your|yours|your own|you)$/i.test(name.trim());
}

/** A mailbox or a calendar, as people write and dictate them: "in box" is
 *  what speech-to-text makes of inbox, "calender" is typed about as often as
 *  the right spelling, and "my email account" is the mailbox too. */
const MAIL_NOUN = "(?:e-?mails?|mail|in\\s?box|mailbox|gmail|sent\\s+(?:mail|folder|items))(?:\\s+account)?";
const CALENDAR_NOUN = "(?:calendar|calender)";
/** "account" alone is the hard one: a bank has one, so does Netflix, and
 *  "my account of the meeting" is not an account at all. */
const ACCOUNT_NOUN = `(?:${MAIL_NOUN}|${CALENDAR_NOUN}|account)`;
/** The nouns that are a place and nothing else. "your email" is as often a
 *  message Enio wrote or its address; "your inbox" is only ever the inbox. */
const PLACE_NOUN = `(?:in\\s?box|mailbox|${CALENDAR_NOUN})`;
/** "you're" and "ur" are "your" as dictation and thumbs produce it; "the
 *  Enio account" is how people name it in the third person. */
const POSSESSIVE = "(my|your|you're|youre|ur|enio'?s|the\\s+enio)(?:\\s+(?:own|latest|newest|new|recent|unread))?";
/**
 * What may follow the noun when a verb of looking leads: the end, a pause,
 * or a word that carries the request on ("for the invoice", "and tell me").
 * A list of what MAY follow and not of what may not, because the other
 * side has no end: "your calendar math", "your email policy", "my email as
 * the username", "my account balance". "for typos" is the one "for" that
 * means a draft and not a mailbox.
 */
const CARRIES_ON =
  "(?=\\s*(?:$|[.!?;,:)\u2014\u2013]|-(?=\\s)|(?:for(?!\\s+(?:any\\s+)?(?:\\w+\\s+)?(?:typos?|tone|errors?|spelling|mistakes|grammar)\\b)|from|and|again|please|today|tonight|tomorrow|yesterday|now|yet|first|then|since|this|next|last|real|quick|quickly|when|if|whether|i|did|do|does|see|tell|to\\s+(?:see|find|look|check)|no|not|instead|too|thanks?|ok|okay|there|after|while|until|because|so|pls|plz|asap|btw|lol|maybe|once|one\\s+more|on\\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day|at\\s+\\d)\\b))";
/** After a preposition the mailbox reading is the common one, so here it is
 *  the short list of compounds that is excluded. "account" is on it because
 *  the optional "account" in the noun otherwise steps back to let "in your
 *  email account settings" through as "in your email". */
const NOT_A_COMPOUND =
  "(?!\\s+(?:account|address|addresses|settings?|app|policy|provider|client|signature|password|invites?|invitation|link|attachment|folder|math|balance|body|footer|header|draft|template|agent|tool|integration|feature|code|module|plugin|server|sync|system)\\b)";
const LOOK =
  "(?:check|read(?:\\s+me)?|open(?:\\s+up)?|search|scan|use|try|show(?:\\s+me)?|pull\\s+up|go\\s+through|keep\\s+an\\s+eye\\s+on|(?:(?:have|take)\\s+a\\s+)?(?:look|peek)\\s+(?:in|into|at|through)|switch\\s+to|go\\s+back\\s+to)";
/** The verbs "mine" and "yours" can stand behind and still mean a mailbox.
 *  Not "show me yours" or "what about yours": those are conversation. */
const LOOK_IN = "(?:check|search|read|open|try|look\\s+(?:in|into|at|through)|switch\\s+to|go\\s+back\\s+to)";
/**
 * Where a request can begin: the start, the end of a clause, or one of the
 * words a request is led in with. Not after a subject: "I'll check my
 * calendar" and "should I check my email less" are not asking Enio to.
 * "you" opens one only behind a modal -- "can you check your inbox" -- since
 * "how often do you look at your inbox?" asks about a habit. That was the
 * one trap of 49 the frozen rule read as Enio's on phrases it had not seen.
 */
const OPENS =
  "(?:^|[.!?;,:\\n]\\s*|\\b(?:(?<!\\b(?:how|when|where|why)\\s+)(?:can|could|would|will|won't|can't)\\s+you|you\\s+to|you\\s+mind|forget\\s+to|remember\\s+to|and|then|no|sorry|wait|just|now|also|please|so|but|enio|yes|ok|okay|actually|um+|uh+|like|hey|hi|well|right|alright|yeah|go\\s+and|show\\s+me|tell\\s+me)[\\s,]+)";
/** Told not to, or told it was not there, the thing named is the one NOT
 *  to look in. Within the clause: a comma ends its reach, so "not yours,
 *  look in my inbox" still asks. "don't forget to check your inbox" is not
 *  one. */
const NOT_NEGATED =
  "(?<!\\b(?:(?:don't|dont|do\\s+not)(?!\\s+(?:forget|hesitate)\\b)|not|never|stop|quit|without|instead\\s+of|rather\\s+than|wasn't|wasnt|isn't|isnt|aren't|arent|weren't|werent|didn't|didnt|doesn't|doesnt)\\b[^.?!;,\\n]{0,40})";

const ASKED: Array<{ shape: RegExp; owner: (m: RegExpMatchArray) => AccountOwner | null }> = [
  // A verb of looking, then whose: "check your email", "um can you go
  // through my emails and tell me".
  {
    shape: new RegExp(`${OPENS}${NOT_NEGATED}${LOOK}\\s+${POSSESSIVE}\\s+${ACCOUNT_NOUN}\\b${CARRIES_ON}`, "gi"),
    owner: (m) => whose(m[1]!),
  },
  // Something IN a mailbox or ON a calendar, however the sentence got
  // there: "has anything landed in your inbox?", "find them in my mail",
  // "what's on my calendar".
  {
    shape: new RegExp(
      `${NOT_NEGATED}\\b(?:(?:in|in\\s+to|into|inside|through)\\s+${POSSESSIVE}\\s+${MAIL_NOUN}|(?:in|on|into|through)\\s+${POSSESSIVE}\\s+${CALENDAR_NOUN})\\b${NOT_A_COMPOUND}`,
      "gi",
    ),
    owner: (m) => {
      const who = whose(m[1] ?? m[2]!);
      // "in your email" is, as often as the mailbox, a message Enio wrote:
      // "there's a typo in your email", "in your mail to Ana you said
      // Tuesday". "in my email" is where people keep things. So one way
      // only, and only for the words that are also a message: "in your
      // inbox" is a place.
      return who === "agent" && /\b(?:e-?mails?|mail)$/i.test(m[0]) ? null : who;
    },
  },
  // "account" after a preposition, held to what may follow: "look in my
  // account for the flight" -- not "my account on Netflix". Not "from" or
  // "with": "anything from your account" is a sender, and "reply from my
  // account" is a send, which this does not steer.
  {
    shape: new RegExp(`${NOT_NEGATED}\\b(?:in|into)\\s+${POSSESSIVE}\\s+account\\b${CARRIES_ON}`, "gi"),
    owner: (m) => whose(m[1]!),
  },
  // The calendar as the thing asked: "does my calendar have anything that
  // day", "is your calendar clear on Friday". Held to what a diary is
  // asked, since "does your calendar support recurring events?" and "is
  // your calendar a Google one?" are about the feature.
  {
    shape: new RegExp(
      `\\b(?:(?:does|what\\s+does|how\\s+does)\\s+${POSSESSIVE}\\s+${CALENDAR_NOUN}\\s+(?:have|say|look|show)|is\\s+${POSSESSIVE}\\s+${CALENDAR_NOUN}\\s+(?:clear|free|busy|full|empty|open))\\b`,
      "gi",
    ),
    owner: (m) => whose(m[1] ?? m[2]!),
  },
  // "what about Enio's calendar", "how about my inbox": the follow-up form.
  {
    shape: new RegExp(`\\b(?:what|how)\\s+about\\s+(?:in\\s+|on\\s+)?${POSSESSIVE}\\s+${PLACE_NOUN}\\b${CARRIES_ON}`, "gi"),
    owner: (m) => whose(m[1]!),
  },
  // The whole message, or its last clause, is the place: "your inbox",
  // "no not yours, my own inbox". Not "your email?", which asks for an
  // address.
  {
    shape: new RegExp(`(?:^|[.!?;,:\\n])\\s*${POSSESSIVE}\\s+${PLACE_NOUN}\\s*(?:please|again|instead|now|then|too)?\\s*[.!?]*\\s*$`, "gi"),
    owner: (m) => whose(m[1]!),
  },
  // "check yours", "go back to mine", "what about in mine": the pronoun
  // standing for the account, at the end of its clause.
  {
    shape: new RegExp(
      `(?:${OPENS}${NOT_NEGATED}${LOOK_IN}|\\b(?:what|how)\\s+about\\s+(?:in|on))\\s+(mine|yours)\\s*(?:please|again|instead|now|then|too)?\\s*(?=$|[.!?;,])`,
      "gi",
    ),
    owner: (m) => (/^mine$/i.test(m[1]!) ? "user" : "agent"),
  },
  // "did anyone write to you?", "who's emailed me since Monday": the
  // mailbox by who the mail was for. "write to", since "who wrote you?" is
  // about who made Enio; and not behind "can" or "if", which ask what is
  // possible.
  {
    shape: new RegExp(
      `(?<!\\b(?:can|could|if|should|would|may|might)\\b[^.?!;,]{0,25})\\b(?:who|who's|whos|anyone|anybody|someone|somebody|no\\s?one|nobody)\\b[^.?!;,]{0,20}?\\b(?:(?:write|wrote|written|writing)\\s+to|emailed|e-mailed)\\s+(you|me)\\b`,
      "gi",
    ),
    owner: (m) => (/^me$/i.test(m[1]!) ? "user" : "agent"),
  },
  // "do I have any new emails", "did I get any mail today": theirs without
  // the word. The mirror ("do you have any mail?") is as often "for me".
  {
    shape: new RegExp(
      `(?:${OPENS}(?:do|did|have)\\s+i\\s+(?:have|get|got|gotten)\\b[^.?!;,]{0,30}?\\b(?:e-?mails?|mail)\\b|\\b(?:e-?mails?|mail)\\s+(?:do|did)\\s+i\\s+(?:have|get)\\b)`,
      "gi",
    ),
    owner: () => "user",
  },
];

/** The longest request in the phrases this is held to is under half this. */
const ASKED_AT_MOST = 400;

/** The possessive as the PERSON said it: "my" is theirs, anything else here
 *  is Enio's. */
function whose(possessive: string): AccountOwner {
  return /^my$/i.test(possessive.trim()) ? "user" : "agent";
}

/** Quotation marks made plain, and what sits between them taken out: that
 *  is somebody else's sentence whoever reads it. */
function unquoted(text: string): string {
  return (
    text
      // Curly quotes, as everywhere a person's words are matched: "Enio’s"
      // is what a phone types.
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/"[^"\n]*"/g, '""')
  );
}

/**
 * The parts of a message that are probably somebody else's words, taken
 * out as well.
 *
 * "your" inside them is not said to Enio. In what a site or a person said
 * it is the user ("Google says check your email"), which is the word read
 * exactly the wrong way round; after a colon it is what the message is
 * about ("reply to Sam: it's on your calendar"). These are guesses about
 * where the person's own words stop, so what they remove may only ever
 * SILENCE a reading, never choose one (ownerAsked).
 */
function ownWords(text: string): string {
  return (
    text
      // Reported speech with no quotation marks, to the end of its
      // sentence. Not "what does my calendar say", nor "who wrote to you".
      .replace(
        /\b(?:says|said|saying|wrote(?!\s+to\s+(?:you|me)\b)|writes|reads|replied|texted|claims?|claimed|mentions?|mentioned|shows|according\s+to|told\s+(?:me|us)|tells\s+(?:me|us)|ask(?:ed|ing|s)\s+(?:me|us)|goes|subject\s+line)\b[^.?!\n]*/gi,
        " ",
      )
      // What follows a colon is what the message is ABOUT, not the asking:
      // "summarize this: please check your inbox", "Ana just texted: the
      // contract is in your inbox". A colon inside a time is not one.
      .replace(/:(?=\s)[\s\S]*$/, "")
  );
}

/** A message that opens by having Enio write to somebody: "your" in it is
 *  the recipient's. No shape closes over who that is ("email Bob Smith,",
 *  "tell my boss", no comma at all), so such a message never reads as
 *  Enio's. */
const WRITES_TO_SOMEONE =
  /^\s*(?:(?:please|can\s+you|could\s+you|ok|okay|now|hey|hi)[\s,]+)*(?:email|e-mail|message|text|tell|ask|write|reply|respond|draft|send|forward|remind|let\s+[\w'-]+\s+know)\b/i;

/** "mine" or "yours" where a mailbox was just spoken of: "that was in your
 *  inbox, I wanted mine". Too loose to read an owner from on its own --
 *  "what's in yours?" is conversation -- and enough to say the message
 *  names both. */
const ALSO_NAMES = /\b(?:in\s+(mine|yours)|(?:wanted|meant|mean)\s+(mine|yours|my|your))\b/gi;

/** Every owner the shapes find in a text, and the one whose match ends last. */
function ownersIn(plain: string): { owners: Set<AccountOwner>; last: AccountOwner | null } {
  const owners = new Set<AccountOwner>();
  let at = -1;
  let last: AccountOwner | null = null;
  for (const { shape, owner: read } of ASKED) {
    for (const m of plain.matchAll(shape)) {
      const who = read(m);
      if (!who) continue;
      owners.add(who);
      const end = m.index + m[0].length;
      if (end >= at) {
        at = end;
        last = who;
      }
    }
  }
  return { owners, last };
}

/**
 * Whose mailbox, calendar or account the person asked to look in, when a
 * possessive alone says it: "check my email", "anything in your inbox?".
 *
 * Read from the PERSON'S message and nowhere else, because that is the one
 * place the words have a fixed meaning: "my" is theirs and "your" is
 * Enio's. Both used to be thrown away as naming nothing, which left "check
 * your email" reading the person's mailbox unless the model chose to pass
 * an account of its own accord.
 *
 * Closed shapes, and tight on the side that costs. "what's your email
 * address?", "send it to my email" and "did you get my email?" must read
 * as nothing: the possessive has to sit on the mailbox itself, behind a
 * verb of looking or a preposition that puts something in it. Words that
 * are not the person's own are taken out first (ownWords). A message that
 * names both owners reads as nothing: one turn has one account to read
 * from, and choosing between two is a guess.
 *
 * It is a grammar and it is wrong sometimes, in both directions, which is
 * why what it decides is small: whose mailbox or calendar THIS turn READS
 * (pickAccount).
 * It moves no conversation and steers no send and no calendar entry.
 * scripts/whose-account-data.json holds the phrases it is held to; the
 * numbers, and what they do not show, are in DECISIONS.md.
 */
export function ownerAsked(text: string): AccountOwner | null {
  // A request is a line or two. Anything longer, or broken over lines, has
  // usually had something pasted into it -- an email, a page -- and "check
  // your inbox" inside that is its author talking, with no quotation marks
  // to say so.
  if (text.length > ASKED_AT_MOST || /\n/.test(text.trim())) return null;
  const whole = unquoted(text);
  const { owners, last } = ownersIn(ownWords(whole));
  // Nothing, or both: "check my inbox, then check yours" is two requests
  // and one turn has one account to read from. The conversation's stands.
  if (owners.size !== 1 || !last) return null;
  // What was set aside as somebody else's words named the OTHER owner. It
  // may have been the person correcting themself ("check your inbox.
  // Actually Ana said it's in mine, so check my inbox"), and a cut must
  // not be what decides.
  const other: AccountOwner = last === "agent" ? "user" : "agent";
  if (ownersIn(whole).owners.has(other)) return null;
  for (const m of whole.matchAll(ALSO_NAMES)) {
    if ((/^(?:mine|my)$/i.test(m[1] ?? m[2]!) ? "user" : "agent") === other) return null;
  }
  if (last === "agent" && WRITES_TO_SOMEONE.test(whole)) return null;
  return last;
}

/**
 * The owner the person asked for this turn, if they did. Harness state like
 * the active account: the turn loop sets it from their message, the picker
 * reads it to choose whose account a READ uses, and a tool reads it to say
 * so when what it read is not what was asked for. Set on every turn, null
 * included, so one turn's word does not reach the next.
 */
export function setAskedOwner(owner: AccountOwner | null): void {
  turn().asked = owner;
}
export function askedOwnerThisTurn(): AccountOwner | null {
  return turn().asked;
}

/**
 * The person's message this turn, kept for one question: do THEIR words
 * support the account the model is asking a tool for?
 *
 * The mail tools take an `account` argument "when the user named one",
 * and the model fills it in when nobody did. Run on the real model with
 * three mailboxes connected: "check my email" in a conversation on Enio's
 * account called search_email with account "enio's" (the account its own
 * prompt had just named), "ok now check my email" chose "work", and "any
 * new mail?" repeated the "enio's" of the call before it. A named account
 * outranks everything, so each of those read a mailbox nobody asked for,
 * and the first read Enio's as the person's.
 *
 * So the argument needs a second voice. It counts when the message holds
 * the account's name, or -- for Enio's own account, and for an owner word
 * -- when the message speaks of that owner and the possessive rule did
 * not hear the other one. Otherwise it is dropped, which leaves the
 * choice to the possessive, the conversation and the default.
 *
 * Held to the literal name alone at first, and review showed the cost:
 * the model's "enio's" is also what carries every request the possessive
 * rule misses ("has Ana replied to you yet?", "did Enio get a reply?",
 * "check my inbox, then yours"), 29 of the 32 such phrases in
 * scripts/whose-account-data.json. The model's reading is wanted where
 * the grammar is silent; what must not happen is the model's reading
 * against the person's words, or with nothing of theirs behind it.
 *
 * Null outside a turn, and in an automation step, whose text is a prompt
 * plus other steps' replies: there the argument stands as it always did.
 */
/** One spelling for comparing what was typed with what is stored: case,
 *  curly apostrophes, accents and runs of spaces are not differences. */
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
export function setTurnMessage(text: string | null): void {
  turn().message = text === null ? null : fold(text);
  turn().said = text === null ? null : text.trim();
  turn().nameRefused = false;
}
export function turnMessageNow(): string | null {
  return turn().message;
}
/** The person's message as they typed it. `turnMessageNow` is folded for
 *  comparing (lower case, no accents); kept as what was asked, it turned
 *  `a file called "Relatório São Paulo.txt"` into a request nobody wrote. */
export function turnMessageSaid(): string | null {
  return turn().said;
}
/** A tool refused a name the person typed and listed the connected
 *  accounts. The model's next argument is its pick from that list, in
 *  answer to the person's own word, and is let through: dropped, "my wrk
 *  inbox" was refused and then quietly read from the default mailbox. */
export function noteNameRefused(): void {
  turn().nameRefused = true;
}

/** Whole words only, with or without a possessive: "enio" for "Enio's". */
function holds(message: string, phrase: string | undefined): boolean {
  const w = fold(phrase ?? "").replace(/'s$/, "");
  if (w.length < 2) return false;
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?:'s)?(?![a-z0-9])`).test(message);
}
/** Mail providers: the part of an address that says nothing about whose
 *  it is. "the acme inbox" names ro@acme.com; "my gmail" names no one. */
const PROVIDER = /^(?:gmail|googlemail|google|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|pm|fastmail|gmx|zoho|mail|email)$/;
/** The person speaking of an owner. Closed, and narrower for Enio: a bare
 *  "you" is in every "can you" and says nothing about a mailbox. */
const SPEAKS_OF: Record<AccountOwner, RegExp> = {
  agent: /\b(?:your|yours|ur|enio(?:'s)?)\b|\b(?:to|for) you\b|\b(?:sent|wrote|written|e-?mailed|mailed|messaged|answered) you\b/,
  user: /\b(?:my|mine|me)\b/,
};
export function personNamed(argument: string, account: Account | null): boolean {
  // In a step set to an account, the only name that counts is that one.
  if (turn().pinned !== null) return account?.id === turn().pinned;
  const message = turn().message;
  if (message === null || turn().nameRefused) return true;
  const domain = account?.email.split("@")[1]?.split(".")[0] ?? "";
  if (
    holds(message, argument) ||
    holds(message, account?.label) ||
    holds(message, account?.email) ||
    (domain.length >= 3 && !PROVIDER.test(domain) && holds(message, domain))
  ) {
    return true;
  }
  // By owner: Enio's own account however the model wrote it, and an owner
  // word ("user's", "personal"). Not one of the person's accounts by its
  // label: "my" does not say which of theirs, and that is how "ok now
  // check my email" came to read "work".
  const owner: AccountOwner | null = account?.owner === "agent" ? "agent" : ownerWord(argument);
  if (!owner) return false;
  const heard = turn().asked;
  return (heard === null || heard === owner) && SPEAKS_OF[owner].test(message);
}

/**
 * Whose mailboxes a mail tool went to this turn, so the turn can tell an
 * answer about the mailbox that was asked for from one put together out
 * of another mailbox's messages already in the conversation. Noted when
 * the account is chosen, not when the call succeeds: a script that failed
 * was still the right place to look.
 */
export function turnMailReads(): ReadonlyArray<AccountOwner | undefined> {
  return turn().mailReads;
}
export function setTurnMailReads(reads: ReadonlyArray<AccountOwner | undefined>): void {
  turn().mailReads = [...reads];
}
export function noteMailRead(owner: AccountOwner | undefined): void {
  turn().mailReads.push(owner);
}
/** An owner is the agent's or it is not: an account with no owner set is
 *  read as the person's everywhere else, and here. */
const ownedBy = (owner: AccountOwner | undefined, asked: AccountOwner) =>
  asked === "agent" ? owner === "agent" : owner !== "agent";
/** Whether this turn looked in a mailbox of the owner the person asked for. */
export function mailReadOf(asked: AccountOwner): boolean {
  return turn().mailReads.some((owner) => ownedBy(owner, asked));
}
/** Whether there is such a mailbox to look in. */
export function canReadMailOf(asked: AccountOwner): boolean {
  return read().accounts.some(
    (a) => a.provider === "appsscript" && a.scriptUrl && a.scriptSecret && a.grants.includes("mail.read") && ownedBy(a.owner, asked),
  );
}



export function scriptAccountWith(grant: Grant | null): PickedAccount | null {
  // Calendar, todos, contacts and documents are the person's: a user
  // account first, whatever the grant.
  const account = pickAccount(grant, "user");
  if (!account) return null;
  // And never Enio's own by fallback, the mail rule again: with only Enio's
  // account connected, "let's set up my calendar" read Enio's calendar and
  // the reply called it "your calendar". Enio's own is used when the person
  // chose it (conversation or default) or named it; agentOnlyAccount lets
  // the tool say so instead.
  if (account.owner === "agent" && !turn().active && !defaultAccountId() && !(turn().asked === "agent" && steered(grant))) return null;
  return picked(account);
}

/** Whether any connected account holds the grant at all -- the question the
 *  tool registry asks. Whose it is decides what a call does, not whether the
 *  tool exists: gating registration on the owner-aware picker withheld
 *  read_calendar when only Enio's own account was connected, and the planner
 *  called a tool it did not hold. */
export function anyAccountWith(grant: Grant | null): boolean {
  return read().accounts.some(
    (a) => a.provider === "appsscript" && a.scriptUrl && a.scriptSecret && (grant === null || a.grants.includes(grant)),
  );
}

/**
 * The notice when nothing of the person's is connected, with the remedy as
 * a link the window opens. Said by the harness at the end of a planner or
 * mail turn that called no tool: with only Enio's own account connected the
 * model answers "no account is connected" from the thread as often as from
 * a tool, and only a tool result carried the link. A closed condition the
 * harness holds, so it is stated either way; a tool that ran already said
 * whose account it used or why it refused. An account whose owner was never
 * set counts as possibly the person's, as it does for the tools.
 */
export function nothingOfYoursNotice(): string | null {
  const all = read().accounts;
  if (all.length === 0) return "No account is connected. Connect one in [Connections](enio://panel/accounts/add).";
  if (all.some((a) => a.owner !== "agent")) return null;
  return "No account of yours is connected — only Enio's own. Connect yours in [Connections](enio://panel/accounts/add).";
}

/** When nothing of the person's can do the act: Enio's own account, if that
 *  is what is connected, so a tool can name it rather than use it or claim
 *  nothing is connected. */
export function agentOnlyAccount(grant: Grant | null): PickedAccount | null {
  // Nor here: a calendar step set to the person's account wrote the event
  // to Enio's calendar when theirs could not be written to.
  if (turn().pinned) return null;
  const a = read().accounts.find(
    (x) => x.owner === "agent" && x.provider === "appsscript" && x.scriptUrl && x.scriptSecret && (grant === null || x.grants.includes(grant)),
  );
  return a ? picked(a) : null;
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
