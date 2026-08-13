import { useEffect, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
// The same file the app icon and launcher use, so boot cannot disagree with
// the rest of the app about what the mark looks like.
import logo from "../../../assets/enio-logo.svg";

/**
 * What the window shows while the backends come up.
 *
 * A cold start reads ~5GB of model weights off disk — up to half a minute
 * during which the launcher used to render greyed-out and silent, which
 * reads as broken, not busy. The main process already narrates every phase
 * ("Checking for a running model server…", "Starting the model server…");
 * this puts that narration where the eye is, with a clock, because a wait
 * that visibly counts is a wait with evidence of progress.
 */
export function BootScreen({ status }) {
  const [seconds, setSeconds] = useState(0);
  const failed = status.phase === "failed";

  useEffect(() => {
    if (failed) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [failed]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
      <div
        aria-hidden="true"
        className={`mx-auto [&>svg]:mx-auto [&>svg]:h-14 [&>svg]:w-auto ${failed ? "" : "animate-pulse"}`}
        dangerouslySetInnerHTML={{ __html: logo }}
      />
      {failed ? (
        <>
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <TriangleAlert className="size-4" /> Could not start
          </p>
          <p className="max-w-sm text-sm text-muted-foreground">{status.message}</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Quit and reopen Enio to try again. If it keeps failing, run{" "}
            <code className="rounded bg-muted px-1">enio up</code> in a terminal to see why.
          </p>
        </>
      ) : (
        <>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {status.message || "Starting up…"}
          </p>
          {/* The honest expectation: a first load reads the whole model off
              disk. Shown once the wait is long enough to wonder about. */}
          {seconds >= 4 && (
            <p className="text-xs text-muted-foreground">
              {seconds}s — a cold start loads ~5GB of model weights and can take about half a
              minute.
            </p>
          )}
        </>
      )}
    </div>
  );
}
