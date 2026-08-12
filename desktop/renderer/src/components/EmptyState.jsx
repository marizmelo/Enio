import { useState } from "react";
import {
  AppWindow,
  ArrowLeft,
  Brain,
  Camera,
  Clapperboard,
  Code,
  FilePen,
  FileSearch,
  Globe,
  House,
  Image,
  Inbox,
  MessageCircle,
  Send,
  ShoppingCart,
  Sparkles,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
// The same file the app icon and the menu bar icon are built from, so the
// three cannot disagree about what the mark looks like.
import logo from "../../../assets/enio-logo.svg";

/** Static name→component map: the server names icons as strings and the
 *  bundle stays tree-shaken — a dynamic lucide import would drag in the
 *  whole icon set. */
const ICONS = {
  "message-circle": MessageCircle,
  globe: Globe,
  "file-search": FileSearch,
  "file-pen": FilePen,
  code: Code,
  inbox: Inbox,
  send: Send,
  "app-window": AppWindow,
  camera: Camera,
  brain: Brain,
  house: House,
  "shopping-cart": ShoppingCart,
  image: Image,
  clapperboard: Clapperboard,
};

/**
 * The launcher: every ability as a tile, picked by the person.
 *
 * A tile is user-side routing. The router classifies well, but a picked tile
 * removes the classification entirely — the suggestions it leads to pin the
 * specialist through the same grammar typed mentions use — and it names what
 * will happen before anything runs.
 *
 * Two screens, deliberately: picking a tile LOCKS onto that ability — the
 * grid goes away and only that ability's "try saying" openings remain, with
 * a back button to choose differently. One thing at a time is the whole
 * philosophy applied to the UI: a locked screen cannot tempt a second choice
 * mid-thought, and the suggestions are about the thing just chosen rather
 * than a generic list. Nothing is ever SENT from here — suggestions prefill
 * the composer and hand the caret over.
 *
 * Unconfigured abilities stay visible, greyed, with the setup path shown on
 * the same locked screen. The model is shown only tools that work (a
 * dead-end tool burns its attention); a person is shown what *could* work,
 * because a person can act on "set ENIO_DESKTOP=1" where the model can only
 * fail.
 */
export function EmptyState({ abilities = [], onPrefill, onOpenPipelines, onEnableDesktop, disabled }) {
  const [enabling, setEnabling] = useState(false);
  const [lockedId, setLockedId] = useState(null);
  const locked = lockedId ? abilities.find((a) => a.id === lockedId) : null;
  const LockedIcon = locked ? (ICONS[locked.icon] ?? Sparkles) : null;

  return (
    // Centering via margin-auto on the inner wrapper, NOT justify-center on
    // the scroll container: with justify-center, content taller than the
    // window overflows both ends and the top half is unreachable — which
    // showed up as the logo arriving beheaded.
    <div className="flex h-full flex-col items-center overflow-y-auto px-6 text-center">
      <div className="m-auto flex w-full flex-col items-center gap-5 py-6">
      <div className="space-y-3">
        <div
          aria-hidden="true"
          className="mx-auto [&>svg]:mx-auto [&>svg]:h-16 [&>svg]:w-auto"
          dangerouslySetInnerHTML={{ __html: logo }}
        />
        <h1 className="text-2xl font-semibold tracking-tight">Enio</h1>
        <p className="text-sm text-muted-foreground">
          A local agent with tools and memory. Nothing leaves your machine.
        </p>
      </div>

      {!locked ? (
        <div className="grid w-full max-w-2xl grid-cols-3 gap-2 sm:grid-cols-4">
          {abilities.filter((a) => !a.launcherHidden).map((a) => {
            const Icon = ICONS[a.icon] ?? Sparkles;
            const available = a.availability === "available";
            return (
              <button
                key={a.id}
                disabled={disabled}
                title={a.description}
                onClick={() => {
                  setLockedId(a.id);
                  // Locking the type also pins it in the composer: the
                  // mention prefix goes in and the caret lands after it, so
                  // whatever is typed next reaches the ability just chosen
                  // rather than the router's guess about it.
                  if (a.availability === "available") {
                    const pin = /^@\w+/.exec(a.promptTemplate);
                    onPrefill(pin ? `${pin[0]} ` : "");
                  }
                }}
                className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-xs transition-colors hover:bg-muted ${
                  available ? "" : "opacity-50"
                }`}
              >
                <Icon className="size-5" />
                <span className="leading-tight">{a.title}</span>
                {!available && (
                  <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                    {a.availability === "future" ? "soon" : "set up"}
                  </span>
                )}
              </button>
            );
          })}

          {/* Client-only, deliberately not an ability: it is a surface, not
              something the pipeline composer may pick as a step. */}
          <button
            disabled={disabled}
            title="Chain abilities together and run them as one"
            onClick={onOpenPipelines}
            className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-2 py-3 text-xs transition-colors hover:bg-muted"
          >
            <Workflow className="size-5" />
            <span className="leading-tight">Build a pipeline</span>
          </button>
        </div>
      ) : (
        <div className="flex w-full max-w-md flex-col gap-3">
          <button
            className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              setLockedId(null);
              onPrefill("");
            }}
          >
            <ArrowLeft className="size-3" /> All abilities
          </button>

          <div className="flex items-center gap-2.5 rounded-lg border bg-muted/40 px-3 py-2.5 text-left">
            <LockedIcon className="size-5 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">{locked.title}</p>
              <p className="text-xs text-muted-foreground">{locked.description}</p>
            </div>
          </div>

          {locked.availability === "available" ? (
            <>
              <p className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                Try saying
              </p>
              {(locked.suggestions ?? []).map((suggestion) => (
                <Button
                  key={suggestion}
                  variant="outline"
                  disabled={disabled}
                  className="h-auto justify-start whitespace-normal px-3.5 py-2 text-left text-sm font-normal"
                  onClick={() => onPrefill(locked.promptTemplate.replace("___", suggestion))}
                >
                  {locked.promptTemplate.replace("___", suggestion).replace(/^@\w+\s*/, "")}
                </Button>
              ))}
              <p className="text-left text-[11px] text-muted-foreground">
                …or just type below — {locked.title.toLowerCase()} is already selected. Nothing
                sends until you do.
              </p>
            </>
          ) : locked.setup ? (
            <div className="rounded-lg border bg-muted/40 p-3 text-left text-xs">
              <p className="mb-1.5 font-medium">{locked.setup.summary}</p>
              {/* The one gate with a user-shaped switch: desktop control is a
                  recorded click here, not an env var. macOS still asks its own
                  per-app permissions after. Deliberately NOT offered for the
                  browser-act gate — that one is a security boundary and stays
                  a step harder than a click. */}
              {locked.requiredFlag === "desktopEnabled" && onEnableDesktop && (
                <Button
                  size="sm"
                  className="mb-2"
                  disabled={enabling}
                  onClick={async () => {
                    setEnabling(true);
                    try {
                      await onEnableDesktop();
                    } finally {
                      setEnabling(false);
                    }
                  }}
                >
                  {enabling ? "Enabling…" : "Enable desktop control"}
                </Button>
              )}
              <ol className="list-decimal space-y-0.5 pl-4 text-muted-foreground">
                {locked.setup.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <button
                className="mt-2 text-muted-foreground underline-offset-2 hover:underline"
                onClick={() =>
                  window.maple?.openExternal(
                    `https://github.com/marizmelo/Enio/tree/master/${locked.setup.docs}`,
                  )
                }
              >
                Read the docs →
              </button>
            </div>
          ) : null}
        </div>
      )}
      </div>
    </div>
  );
}
