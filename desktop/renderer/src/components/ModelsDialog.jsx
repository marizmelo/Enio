import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Download, HardDrive, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  cancelModelDownload,
  currentModel,
  downloadModel,
  modelDownload,
} from "@/lib/recipes";
import { cn } from "@/lib/utils";

const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;

/**
 * Every model this machine could run: the ones already here, and the ones it
 * would have to fetch.
 *
 * The order is the argument. What is installed comes first and switches on one
 * click, because that is the common act and it is instant. Everything else is
 * below a divider that says once — not once per row — that these have to be
 * downloaded. Repeating "needs download" on eight rows spends eight lines
 * saying what the section heading already said.
 *
 * Downloading and switching stay separate. A finished download does not become
 * the running model, because that would restart the model server mid-sentence
 * as a side effect of "get me this one for later".
 */
export function ModelsDialog({ open, onOpenChange, onSwitched, highlight = null }) {
  const [data, setData] = useState(null);
  const [download, setDownload] = useState(null);
  const [switching, setSwitching] = useState("");
  const [error, setError] = useState("");
  const timer = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const next = await currentModel();
      setData(next);
      setDownload(next.download ?? null);
    } catch (err) {
      setError(String(err?.message ?? err));
    }
  }, []);

  useEffect(() => {
    if (open) {
      setError("");
      refresh();
    }
  }, [open, refresh]);

  // Polled rather than streamed. A download reports progress for minutes on
  // end; a second SSE channel to carry a number that changes twice a second is
  // machinery to maintain for something a one-second poll answers. The poll
  // exists only while a download does.
  const active =
    download?.status === "planning" || download?.status === "downloading";
  useEffect(() => {
    clearInterval(timer.current);
    if (!open || !active) return undefined;
    timer.current = setInterval(async () => {
      try {
        const { download: next } = await modelDownload();
        setDownload(next);
        // A finished download changes what is installed, so the lists have to
        // be re-read once — not on every tick.
        if (next && next.status !== "planning" && next.status !== "downloading")
          refresh();
      } catch {
        /* the agent went away; the next open re-reads everything */
      }
    }, 1000);
    return () => clearInterval(timer.current);
  }, [open, active, refresh]);

  const pick = async (id) => {
    if (!data || id === data.current || switching) return;
    setSwitching(id);
    setError("");
    try {
      await onSwitched(id);
      await refresh();
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setSwitching("");
    }
  };

  const fetchModel = async (id) => {
    setError("");
    try {
      const { download: next } = await downloadModel(id);
      setDownload(next);
    } catch (err) {
      setError(String(err?.message ?? err));
    }
  };

  const catalogue = data?.catalogue ?? [];
  const installed = data?.available ?? [];
  // The bundled default and anything already in the cache, with catalogue
  // copy attached where there is any. A model downloaded outside Enio is still
  // listed — it runs, and hiding it would make the list disagree with the
  // machine.
  const installedRows = installed.map((id) => ({
    id,
    ...(catalogue.find((m) => m.id === id) ?? {}),
    label:
      id === "maple"
        ? "Maple"
        : (catalogue.find((m) => m.id === id)?.label ?? id.split("/").pop()),
  }));
  const rest = catalogue.filter((m) => !m.installed);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] gap-0 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Models</DialogTitle>
          <DialogDescription>
            {data?.machineMemory
              ? `This machine has ${gb(data.machineMemory)} of memory, shared between the model and everything else running.`
              : "What this machine can run."}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <section className="mt-4">
          <h3 className="text-xs font-medium text-muted-foreground">
            On this machine
          </h3>
          <ul className="mt-2 space-y-1">
            {installedRows.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  disabled={!!switching}
                  onClick={() => pick(m.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded border p-2.5 text-left text-sm",
                    m.id === data?.current
                      ? "border-primary/50 bg-muted/50"
                      : "hover:bg-muted/50",
                    // An already-downloaded upgrade highlights here instead.
                    m.id === highlight && m.id !== data?.current && "border-primary/60 bg-primary/5",
                  )}
                >
                  <span className="w-4 shrink-0 text-primary">
                    {m.id === data?.current ? (
                      <Check className="size-4" />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {m.label}
                    </span>
                    {m.note && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {m.note}
                      </span>
                    )}
                  </span>
                  {m.measured && (
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      measured here
                    </Badge>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {switching === m.id
                      ? "switching…"
                      : m.id === data?.current
                        ? "running"
                        : "switch"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {rest.length > 0 && (
          <section className="mt-6">
            <h3 className="text-xs font-medium text-muted-foreground">
              Other models
            </h3>
            {/* Said once for the whole section. It is the same fact about
                every row below, and repeating it per row would crowd out the
                thing that does differ — whether it fits. */}
            <p className="mt-1 text-xs text-muted-foreground">
              Not here yet. Each is a one-time download into your Hugging Face
              cache; after that it switches as fast as the rest.
            </p>
            <ul className="mt-2 space-y-1">
              {rest.map((m) => (
                <li
                  key={m.id}
                  className={cn(
                    "flex items-center gap-3 rounded border p-2.5 text-sm",
                    // The model the escalation menu was pointing at, so the
                    // eye lands where the click was aimed.
                    m.id === highlight && "border-primary/60 bg-primary/5",
                  )}
                >
                  <HardDrive className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium">{m.label}</span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {gb(m.bytes)}
                      </span>
                      <FitWarning fit={m.fit} />
                      <SpeedNote speed={m.speed} />
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {m.note}
                    </span>
                    {download?.id === m.id && <Progress download={download} />}
                  </span>
                  {download?.id === m.id && active ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0"
                      onClick={() => cancelModelDownload().then(refresh)}
                    >
                      <X className="size-3.5" /> Stop
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      disabled={active}
                      onClick={() => fetchModel(m.id)}
                    >
                      <Download className="size-3.5" /> Get
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Whether it will fit in memory, said before the download rather than after.
 *
 * Nothing here disables the button. The estimate is a rule of thumb and the
 * person knows things it does not — that they will quit everything else, that
 * the machine is otherwise idle, that they want it regardless. A warning that
 * blocks would be wrong more often than the warning itself is.
 */
/**
 * The other half of "can this Mac run it": fit says whether the weights
 * LOAD, this says whether the tokens come out at a speed you would use.
 * Capacity and bandwidth are different numbers, and the expensive mistake
 * in local AI is a model your hardware can hold but cannot run. An
 * estimate, labelled as one; unknown chips show nothing rather than guess.
 */
function SpeedNote({ speed }) {
  if (!speed || speed.tokensPerSecond === null) return null;
  const cls =
    speed.pace === "slow"
      ? "text-destructive"
      : speed.pace === "usable"
        ? "text-amber-500"
        : "text-muted-foreground";
  const word =
    speed.pace === "slow"
      ? "you'll watch it, not use it"
      : speed.pace === "usable"
        ? "usable"
        : "responsive";
  return (
    <span className={`shrink-0 text-xs tabular-nums ${cls}`} title="Estimated from this machine's memory bandwidth — generation reads every active weight once per token">
      ~{speed.tokensPerSecond} tok/s · {word}
    </span>
  );
}

function FitWarning({ fit }) {
  if (fit === "fits" || !fit) return null;
  const over = fit === "over";
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 text-xs",
        over ? "text-destructive" : "text-amber-500",
      )}
      title={
        over
          ? "Larger than this machine's memory. It will load by swapping to disk, which makes everything slow."
          : "Close to this machine's memory. Expect swapping if much else is open."
      }
    >
      <AlertTriangle className="size-3" />
      {over ? "too big for this machine" : "tight fit"}
    </span>
  );
}

function Progress({ download }) {
  if (download.status === "failed") {
    return (
      <span className="block text-xs text-destructive">{download.error}</span>
    );
  }
  if (download.status === "cancelled") {
    return (
      <span className="block text-xs text-muted-foreground">
        Stopped. Resumes where it left off.
      </span>
    );
  }
  if (download.status === "complete") {
    return <span className="block text-xs text-emerald-500">Downloaded.</span>;
  }
  // Zero total means the file list is still being resolved. Showing 0% then
  // would read as a stalled transfer rather than as a pause before one.
  const pct = download.total
    ? Math.round((download.done / download.total) * 100)
    : null;
  return (
    <span className="mt-1.5 flex items-center gap-2">
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "block h-full rounded-full bg-primary transition-all",
            pct === null && "animate-pulse w-1/3",
          )}
          style={pct === null ? undefined : { width: `${Math.max(pct, 2)}%` }}
        />
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {pct === null
          ? "checking…"
          : `${pct}% · ${gb(download.done)} of ${gb(download.total)}`}
      </span>
    </span>
  );
}
