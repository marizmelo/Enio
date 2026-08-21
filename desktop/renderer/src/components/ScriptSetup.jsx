import { useCallback, useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { saveScript, scriptSource } from "@/lib/accounts";

/**
 * Connecting Google by deploying a script, rather than registering an app.
 *
 * The OAuth route asks every user for a Google Cloud project — five Console
 * steps whose only purpose is giving enio an application identity. A script
 * runs inside the user's own account instead: nothing to register, nothing
 * to publish, no verification, and no seven-day expiry.
 *
 * Enio cannot deploy it for them. Doing that needs the Apps Script API,
 * which needs a Cloud project and OAuth credentials — the exact thing this
 * avoids. So the code is handed over with its secret already in it, and the
 * deploying is six clicks the panel walks through.
 */
export function ScriptSetup({ grants, onConnected, onError }) {
  const [source, setSource] = useState("");
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { source: code } = await scriptSource();
      setSource(code);
    } catch (err) {
      onError?.(String(err.message ?? err));
    }
  }, [onError]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div>
        <p className="text-sm font-medium">Connect with a script</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Runs inside your own Google account, so there is no project to create and nothing to
          verify. Enio cannot deploy it for you — that would need the very credentials this
          avoids — so it is one paste and a few clicks.
        </p>
      </div>

      <ol className="space-y-1 text-xs text-muted-foreground">
        <li>
          1. Copy the code below, then open{" "}
          <button
            className="underline hover:text-foreground"
            onClick={() => window.maple?.openExternal?.("https://script.new")}
          >
            script.new
          </button>{" "}
          and paste it, replacing what is there
        </li>
        <li>2. Deploy → New deployment → Web app</li>
        <li>
          3. Execute as <span className="font-medium">Me</span>, Who has access{" "}
          <span className="font-medium">Anyone</span>
        </li>
        {/* Highlighted because it is the step that looks like something has
            gone wrong: Google shows a red "hasn't verified this app" screen,
            and the honest answer is that the app IS the person reading it.
            Someone who backs out here concludes enio is unsafe rather than
            that they are three clicks from done. */}
        <li className="text-foreground">
          4. Authorize it. Google will warn that the app is{" "}
          <span className="font-medium">not verified</span> — that is expected: the app is your
          own script, and the developer it names is you. Choose Advanced, then &ldquo;Go to
          … (unsafe)&rdquo;, then Allow. If it ever names someone else, stop.
        </li>
        <li>5. Copy the /exec URL it gives you and paste it below</li>
      </ol>

      <button
        className="text-[11px] text-muted-foreground underline hover:text-foreground"
        onClick={() =>
          window.maple?.openExternal?.(
            "https://github.com/marizmelo/Enio/blob/master/docs/accounts.md#connecting-with-a-script",
          )
        }
      >
        How this works, and what the script can and cannot do
      </button>

      <div className="relative">
        <pre className="max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[10px] leading-relaxed">
          {source || "…"}
        </pre>
        <Button
          size="sm"
          variant="outline"
          className="absolute right-1.5 top-1.5 h-6 gap-1 px-2 text-[11px]"
          disabled={!source}
          onClick={async () => {
            await navigator.clipboard.writeText(source);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      <input
        className="w-full rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
        placeholder="https://script.google.com/macros/s/…/exec"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <Button
        size="sm"
        disabled={busy || !url.trim()}
        onClick={async () => {
          onError?.("");
          setBusy(true);
          try {
            // The grants recorded are what the script can do, since with a
            // script the code IS the scope — there is no consent list.
            const { account } = await saveScript(url.trim(), grants.map((g) => g.id));
            setUrl("");
            onConnected?.(account);
          } catch (err) {
            onError?.(String(err.message ?? err));
          }
          setBusy(false);
        }}
      >
        {busy ? "Checking the script…" : "Connect"}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        Anyone holding that URL can use what the script exposes, so treat it like a password.
        Revoke it in Apps Script under Deploy → Manage deployments.
      </p>
    </div>
  );
}
