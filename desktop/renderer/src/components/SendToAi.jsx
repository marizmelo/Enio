import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronDown, Loader2, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cancelHandoff, fetchHandoffs, openSignin, runHandoff } from "@/lib/handoffs";

/**
 * The last step of a handoff, run rather than ferried.
 *
 * "Send to Claude" began as clipboard + open a browser. Users wanted the
 * task to stay inside enio: press the button, the handoff runs, the answer
 * comes back. The server does that through the provider's own CLI agent
 * (claude, codex, gemini) — already installed, already signed in as the
 * user, forced into non-interactive read-only mode — so enio still holds
 * no API keys and the reviewed file is still exactly what leaves.
 *
 * Providers whose CLI is not installed fall back to the old ferry: copy
 * the file, open the web app. Labeled as what it is, never silent.
 *
 * The chosen agent is a habit, not policy: localStorage, same key the
 * ferry used.
 */
const DEFAULT_KEY = "ai-provider";

let agentsCache = null;
async function agents() {
  agentsCache ??= (await fetchHandoffs().then((d) => d.agents).catch(() => [])) ?? [];
  return agentsCache;
}

const mmss = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function SendToAi({ path, onOpenArtifact }) {
  const [list, setList] = useState([]);
  const [defaultId, setDefaultId] = useState(
    () => localStorage.getItem(DEFAULT_KEY) ?? "claude",
  );
  const [run, setRun] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [now, setNow] = useState(Date.now());
  const pollRef = useRef(null);

  useEffect(() => {
    agents().then(setList);
  }, []);

  // One-second heartbeat while a run is live: the elapsed clock and the
  // status poll ride the same tick.
  useEffect(() => {
    if (run?.status !== "running") return undefined;
    pollRef.current = setInterval(async () => {
      setNow(Date.now());
      try {
        const { runs } = await fetchHandoffs();
        const mine = runs.find((r) => r.id === run.id);
        if (mine && mine.status !== "running") setRun(mine);
      } catch {
        /* next tick retries; the run is server-side either way */
      }
    }, 1000);
    return () => clearInterval(pollRef.current);
  }, [run?.id, run?.status]);

  if (list.length === 0) return null;
  const runnable = list.filter((a) => a.available);
  const chosen =
    runnable.find((a) => a.id === defaultId) ?? runnable[0] ?? list[0];

  const start = async (agent) => {
    setError("");
    localStorage.setItem(DEFAULT_KEY, agent.id);
    setDefaultId(agent.id);
    try {
      const { run: started } = await runHandoff(path, agent.id);
      setRun(started);
      setNow(Date.now());
    } catch (err) {
      setError(String(err?.message ?? err));
    }
  };

  const ferry = async (agent) => {
    setError("");
    const result = await window.maple?.sendToAi?.(agent.id, path);
    if (!result) {
      setError("Could not copy the file — is it still there?");
      return;
    }
    setCopied(`Copied — paste into ${result.name}`);
    setTimeout(() => setCopied(""), 4000);
  };

  const running = run?.status === "running";
  const done = run?.status === "done";
  const failed = run?.status === "failed";
  const agentName = (id) => list.find((a) => a.id === id)?.name ?? id;

  return (
    <div className="flex max-w-[85%] flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <div className="inline-flex overflow-hidden rounded-md border">
          {done ? (
            <button
              type="button"
              onClick={() => onOpenArtifact?.(run.answerFile)}
              className="inline-flex items-center gap-1.5 bg-muted/40 px-2.5 py-1.5 text-xs hover:bg-muted"
            >
              <Check className="size-3.5" />
              Open {agentName(run.provider)}&apos;s answer
            </button>
          ) : running ? (
            <button
              type="button"
              title="Stop"
              onClick={() => cancelHandoff(run.id).catch(() => {})}
              className="inline-flex items-center gap-1.5 bg-muted/40 px-2.5 py-1.5 text-xs hover:bg-muted"
            >
              <Loader2 className="size-3.5 animate-spin" />
              {agentName(run.provider)} · {mmss(now - run.startedAt)}
              <X className="size-3 opacity-60" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                chosen.available ? start(chosen) : ferry(chosen)
              }
              title={
                chosen.available
                  ? `Run the handoff with your ${chosen.name} CLI — the answer comes back as a file`
                  : `Copy the handoff and open ${chosen.name}`
              }
              className="inline-flex items-center gap-1.5 bg-muted/40 px-2.5 py-1.5 text-xs hover:bg-muted"
            >
              <ArrowUpRight className="size-3.5" />
              {copied || `Ask ${chosen.name}`}
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Choose an AI"
                className="inline-flex items-center border-l bg-muted/40 px-1.5 hover:bg-muted"
              >
                <ChevronDown className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {runnable.map((a) => (
                <DropdownMenuItem key={a.id} onSelect={() => start(a)}>
                  Ask {a.name}
                  <span className="ml-auto pl-3 text-[10px] text-muted-foreground">
                    runs here
                  </span>
                </DropdownMenuItem>
              ))}
              {list.some((a) => !a.available) && (
                <>
                  {runnable.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
                    No CLI installed — copy &amp; open instead
                  </DropdownMenuLabel>
                  {list
                    .filter((a) => !a.available)
                    .map((a) => (
                      <DropdownMenuItem key={a.id} onSelect={() => ferry(a)}>
                        Copy for {a.name}
                      </DropdownMenuItem>
                    ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {failed && (
        <p className="flex items-center gap-2 text-xs text-destructive" title={run.error}>
          <span>
            {agentName(run.provider)} failed: {run.error?.slice(0, 120)}
          </span>
          {/* The one interactive step, delegated to the real Terminal: a
              .command file runs the CLI's own sign-in flow there. Once is
              enough; after that every run is headless. */}
          {/not signed in/i.test(run.error ?? "") && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await openSignin(run.provider);
                  setRun(null);
                  setCopied("Terminal opened — sign in there, then try again");
                  setTimeout(() => setCopied(""), 6000);
                } catch (err) {
                  setError(String(err?.message ?? err));
                }
              }}
              className="shrink-0 rounded border px-1.5 py-0.5 text-foreground hover:bg-muted"
            >
              Sign in…
            </button>
          )}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
