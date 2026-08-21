import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-accounts-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

const accounts = await import("./accounts.js");
type Grant = (typeof accounts.READ_GRANTS)[number];

after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Accounts hold long-lived credentials, so what is tested here is mostly
 * what must NOT happen: no token reaches a client, no tool reaches a token,
 * and nothing is granted that was not asked for.
 */
describe("the OAuth client", () => {
  test("nothing can start without one", () => {
    assert.equal(accounts.hasClient(), false);
    assert.throws(() => accounts.beginConsent(["mail.read"]), /Add your Google OAuth client/);
  });

  test("a client id that is not Google's is refused where the error is readable", () => {
    // Caught here rather than at the consent screen, which fails with a
    // Google error page that says nothing about which field was wrong.
    assert.throws(() => accounts.setClient("not-a-client", "secret"), /does not look like a Google client ID/);
    assert.throws(() => accounts.setClient("", ""), /client ID and secret/);
  });

  test("a real-shaped client is accepted and never handed back", () => {
    accounts.setClient("1234.apps.googleusercontent.com", "GOCSPX-supersecret");
    assert.equal(accounts.hasClient(), true);
    // hasClient answers the only question a client needs answered.
    assert.ok(!JSON.stringify(accounts.listAccounts()).includes("GOCSPX"));
  });
});

describe("grants", () => {
  test("are a closed list, so a scope cannot be typed in", () => {
    assert.throws(() => accounts.beginConsent(["mail.everything" as never]), /Unknown grant/);
    assert.throws(() => accounts.beginConsent([]), /at least one/);
  });

  test("send is granted without the power to delete mail", () => {
    // gmail.send rather than gmail.modify: sending is what is wanted, and
    // modify would also permit deleting, which nothing here needs.
    assert.match(accounts.GRANTS["mail.send"], /gmail\.send$/);
    assert.ok(!Object.values(accounts.GRANTS).some((s) => /gmail\.modify|mail\.google\.com/.test(s)));
  });

  test("the read-only set is exactly the grants that change nothing", () => {
    for (const g of accounts.READ_GRANTS) {
      assert.match(accounts.GRANTS[g], /readonly$/, `${g} should be a readonly scope`);
    }
    const writes = (Object.keys(accounts.GRANTS) as Grant[]).filter(
      (g) => !accounts.READ_GRANTS.includes(g),
    );
    assert.deepEqual(writes.sort(), ["calendar.write", "drive.write", "mail.send"]);
  });
});

describe("the consent request", () => {
  test("asks Google for exactly the picked scopes, with PKCE and offline access", () => {
    const pending = accounts.beginConsent(["mail.read", "calendar.write"]);
    const url = new URL(pending.url);
    pending.cancel();

    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    const scopes = url.searchParams.get("scope")!.split(" ");
    assert.ok(scopes.includes(accounts.GRANTS["mail.read"]));
    assert.ok(scopes.includes(accounts.GRANTS["calendar.write"]));
    // Nothing was quietly added along the way.
    assert.ok(!scopes.includes(accounts.GRANTS["drive.write"]));
    assert.ok(!scopes.includes(accounts.GRANTS["mail.send"]));

    // A desktop client's secret is not a secret, so the code is bound to a
    // verifier this process holds instead.
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("code_challenge"));
    assert.ok(!url.searchParams.get("client_secret"), "the secret must not ride in the URL");
    // Without these Google returns no refresh token on a repeat consent and
    // the account stops working an hour later.
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
    // Loopback, not the retired out-of-band flow.
    assert.match(url.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/oauth$/);
  });

  test("two flows do not share a challenge", () => {
    const a = accounts.beginConsent(["mail.read"]);
    const b = accounts.beginConsent(["mail.read"]);
    const challenge = (p: { url: string }) => new URL(p.url).searchParams.get("code_challenge");
    assert.notEqual(challenge(a), challenge(b));
    assert.notEqual(new URL(a.url).searchParams.get("state"), new URL(b.url).searchParams.get("state"));
    a.cancel();
    b.cancel();
  });
});

describe("stored accounts", () => {
  test("a client sees the address and grants, never a token", () => {
    // Written directly: getting a real refresh token needs Google.
    const file = accounts.accountsFile();
    writeFileSync(
      file,
      JSON.stringify({
        client: { id: "1234.apps.googleusercontent.com", secret: "GOCSPX-supersecret" },
        accounts: [
          {
            id: "acc1",
            provider: "google",
            email: "me@example.com",
            grants: ["mail.read"],
            addedAt: 1,
            refreshToken: "1//refresh-secret",
            accessToken: "ya29.access-secret",
          },
        ],
      }),
    );
    const listed = accounts.listAccounts();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.email, "me@example.com");
    const asJson = JSON.stringify(listed);
    assert.ok(!asJson.includes("refresh-secret"), "a refresh token leaked");
    assert.ok(!asJson.includes("access-secret"), "an access token leaked");
  });

  test("the file holding refresh tokens is owner-only", () => {
    accounts.setClient("1234.apps.googleusercontent.com", "GOCSPX-supersecret");
    const mode = statSync(accounts.accountsFile()).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });

  test("removing one takes its tokens with it", () => {
    writeFileSync(
      accounts.accountsFile(),
      JSON.stringify({
        client: null,
        accounts: [
          { id: "acc1", provider: "google", email: "me@example.com", grants: [], addedAt: 1, refreshToken: "1//gone" },
        ],
      }),
    );
    assert.equal(accounts.removeAccount("acc1"), true);
    assert.ok(!readFileSync(accounts.accountsFile(), "utf8").includes("1//gone"));
    assert.equal(accounts.removeAccount("acc1"), false, "removing twice is not a second removal");
  });
});

describe("the model cannot reach a credential", () => {
  test("no tool touches accounts", async () => {
    // The invariant this feature inherits: credentials belong to the
    // harness. The model asks for an action, the harness attaches the token,
    // so nothing the model reads can carry one away.
    const { buildRegistry } = await import("./tools/index.js");
    const names = (await buildRegistry()).all.map((t) => t.name);
    for (const name of names) {
      assert.ok(!/account|oauth|token|credential/i.test(name), `${name} looks like credential access`);
    }
  });
});

/**
 * Whose client is a publishing question, not a technical one.
 *
 * "Sign in with Google" is the same flow with the publisher's client id
 * instead of the user's; what separates them is Google verification plus an
 * annual CASA assessment, because Gmail's read scope is restricted. Both
 * paths therefore exist, and flipping between them must be a constant rather
 * than a rewrite.
 */
describe("bundled vs bring-your-own client", () => {
  test("with neither, nothing can start", () => {
    writeFileSync(accounts.accountsFile(), JSON.stringify({ client: null, accounts: [] }));
    delete process.env.ENIO_GOOGLE_CLIENT_ID;
    delete process.env.ENIO_GOOGLE_CLIENT_SECRET;
    assert.equal(accounts.clientSource(), null);
    assert.equal(accounts.hasClient(), false);
  });

  test("a user's own client is what the panel reports", () => {
    accounts.setClient("1234.apps.googleusercontent.com", "GOCSPX-mine");
    assert.equal(accounts.clientSource(), "user");
    assert.equal(accounts.hasClient(), true);
  });

  test("their own client wins over a bundled one", () => {
    // Someone who went to the trouble of registering a client meant to use
    // it — their quota, their consent screen.
    assert.equal(accounts.clientSource(), "user");
    // Cancelled, always: the flow holds a loopback listener open, and a test
    // that leaves one behind keeps the whole process alive.
    const pending = accounts.beginConsent(["mail.read"]);
    const url = new URL(pending.url);
    pending.cancel();
    assert.equal(url.searchParams.get("client_id"), "1234.apps.googleusercontent.com");
  });
});

/**
 * The Apps Script path.
 *
 * It exists because the OAuth route needs a Google Cloud project per user,
 * and that cost buys nothing for someone who just wants their own mail. A
 * script runs inside the user's own account: no client to register, no
 * consent screen to publish, no verification, no seven-day expiry.
 *
 * The trade is that the deployment URL is a bearer credential, so what has
 * to hold is that neither it nor the secret ever comes back out.
 */
describe("script accounts", () => {
  test("the source carries the secret and a version, and defines a closed set of operations", async () => {
    const { scriptSource, SCRIPT_VERSION, OPERATIONS } = await import("./appsscript.js");
    const src = scriptSource("s3cret-value");
    assert.match(src, /const SECRET = "s3cret-value"/);
    assert.match(src, new RegExp(`const VERSION = ${SCRIPT_VERSION}`));
    // Every operation enio can call must exist in the script it ships, or a
    // call fails at runtime with "unknown operation".
    for (const op of OPERATIONS) {
      assert.ok(src.includes(`"${op}"`), `the script is missing ${op}`);
    }
    // Nothing that destroys: the URL is a bearer credential, so the surface
    // it unlocks is the whole security argument.
    assert.ok(
      !/moveToTrash|setTrashed|deleteFile|deleteEvent|deleteTask|removeRow|\.clear\(/.test(src),
      "the script can destroy something",
    );
    // Tasks is an advanced service; a deployment without it must fail with
    // the fix in the error, not a bare "Tasks is not defined".
    assert.match(src, /typeof Tasks === "undefined"/);
    assert.match(src, /Services/);
  });

  test("a stored script account never hands back its URL or secret", () => {
    writeFileSync(accounts.accountsFile(), JSON.stringify({ client: null, accounts: [] }));
    const added = accounts.addScriptAccount({
      email: "me@example.com",
      url: "https://script.google.com/macros/s/AKfy/exec",
      secret: "deployment-secret",
      version: 1,
      grants: ["mail.read"],
    });
    assert.equal(added.provider, "appsscript");
    const listed = JSON.stringify(accounts.listAccounts());
    assert.ok(!listed.includes("deployment-secret"), "the secret leaked");
    assert.ok(!listed.includes("script.google.com"), "the deployment URL leaked");
  });

  test("the harness can fetch the deployment, and removing takes it away", () => {
    const [only] = accounts.listAccounts();
    const script = accounts.scriptFor(only!.id);
    assert.equal(script?.url, "https://script.google.com/macros/s/AKfy/exec");
    assert.equal(script?.secret, "deployment-secret");
    accounts.removeAccount(only!.id);
    assert.equal(accounts.scriptFor(only!.id), null);
    assert.ok(!readFileSync(accounts.accountsFile(), "utf8").includes("deployment-secret"));
  });

  test("re-deploying replaces rather than doubling", () => {
    const add = (url: string) =>
      accounts.addScriptAccount({
        email: "me@example.com",
        url,
        secret: "s",
        version: 1,
        grants: ["mail.read"],
      });
    add("https://script.google.com/macros/s/one/exec");
    add("https://script.google.com/macros/s/two/exec");
    const mine = accounts.listAccounts().filter((a) => a.email === "me@example.com");
    assert.equal(mine.length, 1, "the same address behind a new URL is one account");
    assert.match(accounts.scriptFor(mine[0]!.id)!.url, /two/);
  });

  test("a token refresh is not attempted on a script account", async () => {
    const [only] = accounts.listAccounts().filter((a) => a.provider === "appsscript");
    await assert.rejects(() => accounts.accessTokenFor(only!.id), /script, not an OAuth grant/);
  });
});

describe("what a failed script call says", () => {
  test("a 403 names the setting rather than the status code", async () => {
    // Watched live: a correct deployment refused the call because access was
    // left at the default. "The script returned 403" is true and useless --
    // it sends someone back to the deploy screen with nothing to look for.
    const { callScript } = await import("./appsscript.js");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("<html>denied</html>", { status: 403 })) as typeof fetch;
    const out = await callScript("https://script.google.com/macros/s/x/exec", "s", "ping");
    globalThis.fetch = realFetch;
    assert.equal(out.ok, false);
    assert.match((out as { error: string }).error, /Who has access/);
    // Watched second: the settings SHOWED Anyone and the 403 persisted --
    // reproduced with curl from outside enio. Access edited on an existing
    // deployment sometimes never propagates, so the error has to offer the
    // fix that actually works: a new deployment with a fresh URL.
    assert.match((out as { error: string }).error, /NEW deployment/i);
  });
});

describe("the pending script secret", () => {
  test("survives a restart, because the user may have already deployed it", () => {
    // The in-memory version broke on first real use: code copied, enio
    // restarted, URL pasted -- and the fresh process had minted a fresh
    // secret, so the deployed script answered "unauthorized" with every
    // visible setting correct.
    const first = accounts.pendingScriptSecret();
    assert.equal(accounts.pendingScriptSecret(), first, "stable across calls");
    assert.ok(readFileSync(accounts.accountsFile(), "utf8").includes(first), "persisted, not module state");
    accounts.clearPendingScriptSecret();
    assert.notEqual(accounts.pendingScriptSecret(), first, "cleared means consumed");
  });

  test("the script has a status page a browser can check, and it leaks nothing", async () => {
    const { scriptSource } = await import("./appsscript.js");
    const src = scriptSource("hidden-secret");
    assert.match(src, /function doGet\(\)/);
    assert.match(src, /is running/);
    // doGet is the anonymous probe, so its output must not reference the
    // secret even indirectly.
    const doGet = src.slice(src.indexOf("function doGet"), src.indexOf("function doPost"));
    assert.ok(!doGet.includes("SECRET"), "the status page touches the secret");
  });
});

describe("upgrading a deployed script", () => {
  test("the upgrade secret is the connected account's, so redeploying is not reconnecting", () => {
    writeFileSync(accounts.accountsFile(), JSON.stringify({ client: null, accounts: [] }));
    assert.equal(accounts.scriptUpgradeSecret(), null, "no account, no upgrade secret");
    accounts.addScriptAccount({
      email: "me@example.com",
      url: "https://script.google.com/macros/s/live/exec",
      secret: "deployed-secret",
      version: 2,
      grants: ["mail.read"],
    });
    assert.equal(accounts.scriptUpgradeSecret(), "deployed-secret");
    const byUrl = accounts.scriptAccountByUrl("https://script.google.com/macros/s/live/exec");
    assert.equal(byUrl?.secret, "deployed-secret");
    assert.equal(accounts.scriptAccountByUrl("https://script.google.com/macros/s/other/exec"), null);
  });

  test("a re-connect records the new version on the same account", () => {
    const [only] = accounts.listAccounts();
    accounts.updateScriptVersion(only!.id, 3);
    assert.equal(accounts.scriptFor(only!.id)?.version, 3);
    assert.equal(accounts.listAccounts().length, 1, "an upgrade is not a second account");
  });
});
