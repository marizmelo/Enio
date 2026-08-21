import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readBody, sendJson } from "../http-util.js";
import {
  GRANTS,
  READ_GRANTS,
  addScriptAccount,
  beginConsent,
  clientSource,
  hasClient,
  listAccounts,
  removeAccount,
  setClient,
  type Account,
  type Grant,
  type PendingConsent,
} from "../accounts.js";
import { SCRIPT_VERSION, callScript, scriptSource } from "../appsscript.js";

/**
 * Connecting a Google account, and seeing what is connected.
 *
 * Behind the same bearer auth as everything else, and — like the cloud
 * targets — reachable only from a client. No tool touches any of this: the
 * model asks for an action and the harness attaches the token, so a page it
 * reads cannot start a consent flow or name an account into existence.
 *
 * The flow is two steps because of an ordering problem, not taste. The
 * client has to open the consent URL, and it cannot read a URL out of a
 * response that is being held open until consent finishes. So starting
 * returns the URL immediately and the client polls for the outcome.
 */

interface Flow {
  pending: PendingConsent;
  startedAt: number;
  status: "pending" | "connected" | "failed";
  account?: Account;
  error?: string;
}

const flows = new Map<string, Flow>();

/** The secret handed out with the script source, held until the deployment
 *  URL comes back. One at a time: a second Copy before the first is pasted
 *  would otherwise strand whichever script was deployed. */
let pendingSecret: string | null = null;

/** Consent is a person walking through screens; ten minutes is generous and
 *  bounded, where an unbounded map would hold a listener open forever on
 *  every abandoned attempt. */
const FLOW_TTL_MS = 10 * 60_000;

function sweep(): void {
  for (const [id, flow] of flows) {
    if (Date.now() - flow.startedAt < FLOW_TTL_MS) continue;
    if (flow.status === "pending") flow.pending.cancel();
    flows.delete(id);
  }
}

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/accounts") {
    sendJson(res, 200, {
      client: hasClient(),
      // "bundled" means enio ships a verified client and the panel can just
      // say Sign in with Google; "user" means they registered their own.
      clientSource: clientSource(),
      accounts: listAccounts(),
      // The vocabulary the picker is built from, so the client never has to
      // hold its own copy of the grant list and drift from this one.
      grants: Object.keys(GRANTS).map((id) => ({
        id,
        readOnly: READ_GRANTS.includes(id as Grant),
      })),
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/accounts/client") {
    const body = JSON.parse((await readBody(req)) || "{}") as { id?: string; secret?: string };
    try {
      setClient(String(body.id ?? ""), String(body.secret ?? ""));
      sendJson(res, 200, { client: true });
    } catch (err) {
      sendJson(res, 400, { error: { message: (err as Error).message } });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/accounts/connect") {
    sweep();
    const body = JSON.parse((await readBody(req)) || "{}") as { grants?: string[] };
    try {
      const pending = beginConsent((body.grants ?? []) as Grant[]);
      const id = randomBytes(8).toString("hex");
      const flow: Flow = { pending, startedAt: Date.now(), status: "pending" };
      flows.set(id, flow);
      // Recorded when it settles rather than awaited here: the client needs
      // the URL now, and cannot open it from a response held open until the
      // consent it has not shown yet completes.
      pending.done
        .then((account) => {
          flow.status = "connected";
          flow.account = account;
        })
        .catch((err: Error) => {
          flow.status = "failed";
          flow.error = err.message;
        });
      sendJson(res, 200, { flowId: id, url: pending.url });
    } catch (err) {
      sendJson(res, 400, { error: { message: (err as Error).message } });
    }
    return true;
  }

  /**
   * The script path: enio hands over source with a secret already in it, the
   * user deploys it, and pastes the URL back.
   *
   * The secret is minted here rather than in the browser so it is generated
   * once, server-side, and lands in the same file every other credential
   * does. Asking again returns the same code for the same pending secret --
   * a regenerated secret between "copy" and "paste" would mean the deployed
   * script and the stored one disagree, which fails at the first call with
   * "unauthorized" and no explanation.
   */
  if (req.method === "GET" && url.pathname === "/accounts/script") {
    if (!pendingSecret) pendingSecret = randomBytes(24).toString("base64url");
    sendJson(res, 200, { version: SCRIPT_VERSION, source: scriptSource(pendingSecret) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/accounts/script") {
    const body = JSON.parse((await readBody(req)) || "{}") as { url?: string; grants?: string[] };
    const deployment = String(body.url ?? "").trim();
    if (!/^https:\/\/script\.google\.com\/.*\/exec$/.test(deployment)) {
      sendJson(res, 400, {
        error: {
          message: 'That is not a deployment URL. It comes from Deploy > New deployment and ends in "/exec".',
        },
      });
      return true;
    }
    if (!pendingSecret) {
      sendJson(res, 400, { error: { message: "Ask for the script again — its secret was not kept." } });
      return true;
    }
    // Called before it is saved: a URL that does not answer is a setup that
    // silently does nothing later, and the failure is far easier to fix while
    // the person is still looking at the deploy screen.
    const ping = await callScript(deployment, pendingSecret, "ping");
    if (!ping.ok) {
      sendJson(res, 400, { error: { message: ping.error } });
      return true;
    }
    const info = ping.result as { email?: string; version?: number };
    if (info?.version !== SCRIPT_VERSION) {
      sendJson(res, 400, {
        error: {
          message: `That deployment runs v${info?.version ?? "?"} of the script and this enio expects v${SCRIPT_VERSION}. Copy the code again and redeploy.`,
        },
      });
      return true;
    }
    const account = addScriptAccount({
      email: info.email || "unknown",
      url: deployment,
      secret: pendingSecret,
      version: SCRIPT_VERSION,
      grants: (body.grants ?? []) as Grant[],
    });
    pendingSecret = null;
    sendJson(res, 200, { account });
    return true;
  }

  const poll = url.pathname.match(/^\/accounts\/connect\/([0-9a-f]{16})$/);
  if (req.method === "GET" && poll) {
    const flow = flows.get(poll[1]!);
    if (!flow) {
      sendJson(res, 404, { error: { message: "That sign-in is no longer waiting." } });
      return true;
    }
    if (flow.status === "pending") {
      sendJson(res, 200, { status: "pending" });
      return true;
    }
    // One-shot: the outcome is delivered once and the listener released.
    flows.delete(poll[1]!);
    if (flow.status === "connected") sendJson(res, 200, { status: "connected", account: flow.account });
    else sendJson(res, 200, { status: "failed", error: flow.error ?? "Sign-in failed." });
    return true;
  }

  if (req.method === "DELETE" && poll) {
    const flow = flows.get(poll[1]!);
    if (flow) {
      flow.pending.cancel();
      flows.delete(poll[1]!);
    }
    sendJson(res, 200, { cancelled: true });
    return true;
  }

  const one = url.pathname.match(/^\/accounts\/([0-9a-f]{16})$/);
  if (req.method === "DELETE" && one) {
    // Local only, and the UI says so: revoking at Google is the part that
    // actually ends access, and pretending a local delete does that would be
    // the most dangerous lie this panel could tell.
    if (!removeAccount(one[1]!)) {
      sendJson(res, 404, { error: { message: "No such account." } });
      return true;
    }
    sendJson(res, 200, { removed: one[1] });
    return true;
  }

  return false;
}
