import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readBody, sendJson } from "../http-util.js";
import {
  GRANTS,
  READ_GRANTS,
  beginConsent,
  hasClient,
  listAccounts,
  removeAccount,
  setClient,
  type Account,
  type Grant,
  type PendingConsent,
} from "../accounts.js";

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
