import { useCallback, useEffect, useRef, useState } from "react";
import { Accessibility, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { permissions } from "@/lib/conversations";

/**
 * The one capability that exists but is switched off at the OS.
 *
 * Everything else here follows the rule that an affordance which cannot work
 * is not shown at all -- the microphone appears only once whisper is
 * installed, a tool that can only fail is withheld. Accessibility is the case
 * that rule handles badly: clicking by name is fully built and one toggle away,
 * so hiding it silently means the user never learns it exists, and the agent
 * just seems unable to do things it can do.
 *
 * So it is shown, once, with the button that fixes it -- and dismissing it
 * sticks, because a banner that returns every launch is an advert.
 *
 * The state comes from the agent rather than from Electron. Electron answers
 * for Enio.app; the agent is the process that actually runs osascript, and it
 * is the only one whose answer is the truth.
 */
const DISMISSED = "enio.accessibility-notice-dismissed";

export function PermissionNotice({ backendReady }) {
  const [granted, setGranted] = useState(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED) === "1");
  const [waiting, setWaiting] = useState(false);
  const polling = useRef(null);

  const check = useCallback(async () => {
    try {
      const state = await permissions();
      setGranted(state.accessibility);
      return state.accessibility;
    } catch {
      // Never a reason to show anything: an unreachable agent is already
      // reported by the status bar, and a second complaint helps nobody.
      setGranted(null);
      return null;
    }
  }, []);

  useEffect(() => {
    if (backendReady) check();
  }, [backendReady, check]);

  // Granting happens in System Settings, in another window, with no event to
  // subscribe to -- so the only way to notice is to keep asking. Stops as soon
  // as it succeeds, and gives up rather than polling forever.
  const startPolling = useCallback(() => {
    if (polling.current) return;
    let tries = 0;
    setWaiting(true);
    polling.current = setInterval(async () => {
      tries += 1;
      const ok = await check();
      if (ok || tries > 60) {
        clearInterval(polling.current);
        polling.current = null;
        setWaiting(false);
      }
    }, 2000);
  }, [check]);

  useEffect(() => () => polling.current && clearInterval(polling.current), []);

  const grant = useCallback(async () => {
    await window.maple?.requestAccessibility();
    startPolling();
  }, [startPolling]);

  if (granted !== false || dismissed) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl items-start gap-3 rounded-md border border-dashed px-3 py-2.5 text-xs">
      <Accessibility className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-foreground">Let Enio click buttons and menus for you</p>
        <p className="mt-0.5 text-muted-foreground">
          {waiting
            ? "Waiting for macOS… add Enio under Accessibility, then come back."
            : "macOS needs to allow this under Privacy & Security → Accessibility."}
        </p>
      </div>
      <Button size="sm" variant="outline" className="shrink-0" disabled={waiting} onClick={grant}>
        {waiting ? "Waiting…" : "Open Settings"}
      </Button>
      <button
        aria-label="Dismiss"
        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => {
          localStorage.setItem(DISMISSED, "1");
          setDismissed(true);
        }}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
