import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScriptSetup } from "@/components/ScriptSetup";
import {
  GRANT_LABELS,
  accountStatus,
  cancelConnect,
  connectStatus,
  listAccounts,
  removeAccount,
  saveClient,
  startConnect,
} from "@/lib/accounts";

/**
 * Google accounts.
 *
 * Two things this panel has to get right, both from the recorded decision.
 *
 * An account arrives **read-only**: the write grants start unticked, and
 * turning one on is a separate act. More logged-in surface is more blast
 * radius for the injection path browsing already documents, and a picker
 * that pre-ticks "send mail" makes that the default without anyone choosing.
 *
 * And **removing here is local**. Revoking at Google is what actually ends
 * access; saying otherwise would be the most dangerous lie the panel could
 * tell, so the link to Google's own permissions page sits next to Remove.
 */
export function AccountsPanel({ onError }) {
  const [state, setState] = useState({ client: false, clientSource: null, accounts: [], grants: [] });
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [picked, setPicked] = useState(() => new Set(["mail.read"]));
  const [connecting, setConnecting] = useState(false);
  // Which way to connect. Script first, because it is the shorter road and
  // needs no Google Cloud project at all -- the OAuth route's five Console
  // steps buy an application identity that a script does not need.
  const [how, setHow] = useState("script");
  // Whether the add-account card is open. Collapsed once anything is
  // connected: the first success used to leave the setup form on screen with
  // the new account rendered nowhere -- the panel branched on the OAuth
  // client, which a script account never sets -- so "Connect" looked like it
  // did nothing and got pressed again, against a secret the success had
  // already consumed.
  const [adding, setAdding] = useState(false);
  // id -> { ok, error } | undefined while checking. Same honesty as the MCP
  // rows: the dot answers "does it currently work", not "was it once saved".
  const [status, setStatus] = useState({});
  const pollRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const next = await listAccounts();
      setState(next);
      for (const a of next.accounts) {
        accountStatus(a.id)
          .then((s) => setStatus((prev) => ({ ...prev, [a.id]: s })))
          .catch(() => setStatus((prev) => ({ ...prev, [a.id]: { ok: false, error: "unreachable" } })));
      }
    } catch (err) {
      onError?.(String(err.message ?? err));
    }
  }, [onError]);

  useEffect(() => {
    refresh();
    return () => clearInterval(pollRef.current);
  }, [refresh]);

  const toggle = (id) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const connect = async () => {
    onError?.("");
    setConnecting(true);
    try {
      const { flowId, url } = await startConnect([...picked]);
      // The system browser, never an embedded one: Google refuses OAuth from
      // a webview outright (disallowed_useragent), because an embeddable
      // browser can man-in-the-middle its own login page.
      window.maple?.openExternal?.(url) ?? window.open(url, "_blank");
      pollRef.current = setInterval(async () => {
        try {
          const status = await connectStatus(flowId);
          if (status.status === "pending") return;
          clearInterval(pollRef.current);
          setConnecting(false);
          if (status.status === "failed") onError?.(status.error);
          refresh();
        } catch (err) {
          clearInterval(pollRef.current);
          setConnecting(false);
          onError?.(String(err.message ?? err));
        }
      }, 1500);
    } catch (err) {
      setConnecting(false);
      onError?.(String(err.message ?? err));
    }
  };

  const accountsList = state.accounts.length > 0 && (
    <>
      <div className="rounded-md border">
        {state.accounts.map((a) => (
          <div key={a.id} className="flex items-start gap-2 border-b p-3 last:border-b-0">
            <span
              className={`mt-1.5 size-2 shrink-0 rounded-full ${
                status[a.id] === undefined
                  ? "bg-muted-foreground/40"
                  : status[a.id].ok
                    ? "bg-emerald-500"
                    : "bg-destructive"
              }`}
              title={
                status[a.id] === undefined
                  ? "Checking…"
                  : status[a.id].ok
                    ? "Connected — the account answers"
                    : status[a.id].error || "Not answering"
              }
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {a.email === "unknown" ? "Google account (via script)" : a.email}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {a.provider === "appsscript" ? "script · " : ""}
                {a.grants.map((g) => GRANT_LABELS[g] ?? g).join(" · ") || "nothing granted"}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 gap-1 px-2 text-xs"
              onClick={async () => {
                try {
                  await removeAccount(a.id);
                  refresh();
                } catch (err) {
                  onError?.(String(err.message ?? err));
                }
              }}
            >
              <Trash2 className="size-3" /> Remove
            </Button>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Remove stops Enio using the account. To end the grant itself,{" "}
        <button
          className="inline-flex items-center gap-0.5 underline hover:text-foreground"
          onClick={() => window.maple?.openExternal?.("https://myaccount.google.com/permissions")}
        >
          revoke it at Google <ExternalLink className="size-2.5" />
        </button>
        {" "}— for a script, also archive its deployment in Apps Script.
      </p>
    </>
  );

  // Nothing to set up when enio ships a verified client: the Console
  // walkthrough exists because the user has to register an app, and showing
  // it to someone who does not would be four steps of pure noise.
  if (!state.client) {
    return (
      <div className="space-y-2">
        {accountsList}
        {state.accounts.length > 0 && !adding ? (
          <Button size="sm" variant="outline" className="gap-1" onClick={() => setAdding(true)}>
            <UserPlus className="size-3.5" /> Add another account
          </Button>
        ) : (
        <>
        <div className="flex gap-1">
          {[
            ["script", "Deploy a script"],
            ["oauth", "Register an app"],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setHow(id)}
              className={`rounded-md px-2 py-1 text-xs ${
                how === id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {how === "script" ? (
          <ScriptSetup
            grants={state.grants}
            onError={onError}
            onConnected={() => {
              setAdding(false);
              refresh();
            }}
          />
        ) : (
      <div className="space-y-3 rounded-md border p-3">
        <div>
          <p className="text-sm font-medium">Connect a Google account</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Google ties mail and calendar access to a registered app, so Enio uses one you own —
            your project, your quota, no shared secret. About five minutes, once.
          </p>
        </div>
        <ol className="space-y-1 text-xs text-muted-foreground">
          <li>
            1. Create a project at{" "}
            <button
              className="underline hover:text-foreground"
              onClick={() => window.maple?.openExternal?.("https://console.cloud.google.com/projectcreate")}
            >
              console.cloud.google.com
            </button>
          </li>
          <li>2. In APIs &amp; Services → Library, enable the Gmail, Calendar and Drive APIs</li>
          <li>3. In OAuth consent screen, choose External and add yourself under Test users</li>
          <li>4. In Credentials, create an OAuth client ID of type Desktop app</li>
          {/* The step everyone misses, and it fails a week later rather than
              immediately: an external consent screen left in "Testing" issues
              refresh tokens that expire after 7 days, so the account quietly
              stops working. Publishing keeps them; the unverified warning is
              yours to accept on your own app. */}
          <li className="text-foreground">
            5. Back on OAuth consent screen, press{" "}
            <span className="font-medium">Publish app</span> — in Testing, Google expires the
            sign-in after 7 days and you would reconnect every week. You will see an
            &ldquo;unverified app&rdquo; notice at sign-in; it is your own app, so choose
            Advanced and continue.
          </li>
        </ol>
        <button
          className="text-[11px] text-muted-foreground underline hover:text-foreground"
          onClick={() =>
            window.maple?.openExternal?.(
              "https://github.com/marizmelo/Enio/blob/master/docs/accounts.md#setting-it-up-with-oauth-instead",
            )
          }
        >
          How this works, and why Google asks for it
        </button>
        <div className="space-y-2">
          <input
            className="w-full rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
            placeholder="Client ID (ends in .apps.googleusercontent.com)"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
          <input
            type="password"
            className="w-full rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
            placeholder="Client secret"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
          <Button
            size="sm"
            disabled={!clientId.trim() || !clientSecret.trim()}
            onClick={async () => {
              onError?.("");
              try {
                await saveClient(clientId.trim(), clientSecret.trim());
                setClientId("");
                setClientSecret("");
                refresh();
              } catch (err) {
                onError?.(String(err.message ?? err));
              }
            }}
          >
            Save
          </Button>
        </div>
      </div>
        )}
        </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {state.accounts.length > 0 && (
        <div className="rounded-md border">
          {state.accounts.map((a) => (
            <div key={a.id} className="flex items-start gap-2 border-b p-3 last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{a.email}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {a.grants.map((g) => GRANT_LABELS[g] ?? g).join(" · ") || "nothing granted"}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 gap-1 px-2 text-xs"
                onClick={async () => {
                  try {
                    await removeAccount(a.id);
                    refresh();
                  } catch (err) {
                    onError?.(String(err.message ?? err));
                  }
                }}
              >
                <Trash2 className="size-3" /> Remove
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Said where it is read, not buried in docs: a local delete stops Enio
          using the account, and only Google can end the grant itself. */}
      {state.accounts.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Remove stops Enio using the account. To end the grant itself,{" "}
          <button
            className="inline-flex items-center gap-0.5 underline hover:text-foreground"
            onClick={() => window.maple?.openExternal?.("https://myaccount.google.com/permissions")}
          >
            revoke it at Google <ExternalLink className="size-2.5" />
          </button>
          .
        </p>
      )}

      <div className="space-y-2 rounded-md border p-3">
        <p className="text-sm font-medium">Add an account</p>
        <div className="grid grid-cols-2 gap-1">
          {state.grants.map((g) => (
            <label key={g.id} className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                className="size-3.5"
                checked={picked.has(g.id)}
                onChange={() => toggle(g.id)}
              />
              <span className={g.readOnly ? "" : "text-amber-600 dark:text-amber-500"}>
                {GRANT_LABELS[g.id] ?? g.id}
              </span>
            </label>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Amber ones let Enio change things in your account. Grant them only when you want it
          acting, not just reading.
        </p>
        <Button size="sm" disabled={connecting || picked.size === 0} onClick={connect} className="gap-1">
          <UserPlus className="size-3.5" />
          {connecting ? "Waiting for Google…" : "Connect with Google"}
        </Button>
        {connecting && (
          <button
            className="ml-2 text-[11px] text-muted-foreground underline hover:text-foreground"
            onClick={() => {
              clearInterval(pollRef.current);
              setConnecting(false);
              cancelConnect();
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
