import { useEffect, useState } from "react";
import { BookOpen, Brain, Briefcase, CircleHelp, Disc, FolderOpen, History, MessageSquarePlus, NotebookPen, TerminalSquare, Workflow, X } from "lucide-react";
import { ModelPicker } from "@/components/ModelPicker";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TipButton } from "@/components/TipButton";
import { cn } from "@/lib/utils";

/**
 * The documentation, on GitHub.
 *
 * The repository folder rather than a Pages URL: /docs renders there today
 * whether or not Pages is ever switched on, so the link cannot be dead. If
 * Pages is enabled, change this to the published site — the pages are the
 * same files either way.
 */
const DOCS_URL = "https://github.com/marizmelo/Enio/tree/master/docs";

const DOT = {
  ready: "bg-emerald-500",
  failed: "bg-destructive",
  starting: "bg-amber-500 animate-pulse",
};

/**
 * Backend lifecycle, pushed from the main process over IPC. It stays visible
 * rather than disappearing once ready, because the one question this window
 * cannot answer on its own is whether the model is actually up.
 */
export function StatusBar({
  phase,
  message,
  tools,
  context,
  project,
  onNewChat,
  onHistory,
  onSkills,
  onFiles,
  onProjects,
  onPipelines,
  onMemory,
  onNotes,
  meeting,
  onToggleMeeting,
  onCloseProject,
  running = 0,
  onCommands,
}) {
  return (
    // The window uses titleBarStyle "hiddenInset", so macOS draws its traffic
    // lights over the top-left of the page rather than in a title bar of its
    // own. Nothing reserves that space automatically -- the left padding is
    // what keeps the status dot from sitting underneath the close button.
    // Dragging is restored here too, since with the title bar hidden this
    // strip is the only thing left to move the window by.
    <header
      className="flex shrink-0 items-center gap-3 border-b py-2.5 pr-4 pl-[86px] text-xs text-muted-foreground [-webkit-app-region:drag]"
    >
      <span className="shrink-0 text-sm font-semibold text-foreground">Enio</span>

      {/* no-drag, or the click starts a window drag instead: the whole bar is
          a drag region because the title bar is hidden. */}
      <div className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]">
        <TipButton tip="New chat" className="size-7" onClick={onNewChat}>
          <MessageSquarePlus className="size-3.5" />
        </TipButton>
        <TipButton tip="Conversations" className="size-7" onClick={onHistory}>
          <History className="size-3.5" />
        </TipButton>
        {/* The project chip: named when one is open, an icon otherwise. Named
            because the open project silently shapes every turn — routing bias,
            instructions, which folders the tools reach — and state that shapes
            behavior invisibly gets misread as the model acting strangely.
            Ahead of Files because it scopes what Files means. */}
        {project ? (
          <div className="mx-1 flex items-center gap-1 rounded-full border pl-2.5 pr-1 py-1 text-xs text-foreground">
            <button
              onClick={onProjects}
              className="flex items-center gap-1.5 hover:opacity-70"
              title="Project settings"
            >
              <Briefcase className="size-3" />
              <span className="max-w-40 truncate">{project.name}</span>
            </button>
            {/* Leaving is one click because entering was: the chip is scope
                the user granted, and revoking a grant should never be buried
                a dialog deep. This conversation stays the project's — leaving
                lands in a fresh chat outside it, files untouched. */}
            <button
              onClick={onCloseProject}
              className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              title={`Leave ${project.name} — starts a new chat outside it`}
            >
              <X className="size-3" />
            </button>
          </div>
        ) : (
          <TipButton tip="Projects" className="size-7" onClick={onProjects}>
            <Briefcase className="size-3.5" />
          </TipButton>
        )}
        {/* The launcher tile only exists before the first message, and a
            pipeline is exactly the thing you reach for mid-conversation --
            "this worked, make it repeatable". */}
        <TipButton tip="Automations" className="size-7" onClick={onPipelines}>
          <Workflow className="size-4" />
        </TipButton>
        {/* The other half of "things that repeat": automations RUN, skills
            INFORM. Two buttons, because those are the two concepts -- saved
            scripts moved inside Automations, where the things that act live. */}
        <TipButton tip="Skills" className="size-7" onClick={onSkills}>
          <BookOpen className="size-4" />
        </TipButton>
        {/* What Enio remembers about you -- and the way to prune it. Beside
            the other standing surfaces because memory speaks in every turn,
            and a thing with that reach must be one click from any thread. */}
        <TipButton tip="Memory" className="size-7" onClick={onMemory}>
          <Brain className="size-4" />
        </TipButton>
        {/* The managed note collection -- the first section that is an app
            rather than a door into the chat room. */}
        <TipButton tip="Notes" className="size-7" onClick={onNotes}>
          <NotebookPen className="size-4" />
        </TipButton>
        {/* Start and stop are user acts here, never tool calls -- the one
            design decision that makes a fabricated "I stopped and here is
            the summary" impossible. Hidden entirely when transcription is
            not installed: an affordance that cannot work is not shown. */}
        {onToggleMeeting && (
          <TipButton
            tip={meeting?.status === "recording" ? "Stop recording" : "Record a meeting"}
            className={`size-7 ${meeting?.status === "recording" ? "text-destructive" : ""}`}
            onClick={onToggleMeeting}
          >
            <Disc className={`size-4 ${meeting?.status === "recording" ? "animate-pulse" : ""}`} />
          </TipButton>
        )}
        {meeting?.status === "recording" && (
          <RecordingClock startedAt={meeting.startedAt} />
        )}
        {(meeting?.status === "transcribing" || meeting?.status === "summarizing") && (
          <span className="text-xs text-muted-foreground">
            {meeting.status === "transcribing" ? "transcribing…" : "writing notes…"}
          </span>
        )}
        <TipButton tip="Files" className="size-7" onClick={onFiles}>
          <FolderOpen className="size-3.5" />
        </TipButton>
        {/* Only when something is actually running. A process an agent started
            outlives its turn, so the one thing this bar must never do is let
            it run unseen -- but an always-present icon for the empty case
            would be a permanent reminder of nothing. The count is the label:
            "is anything running" is the question, and it is answered without
            opening anything. */}
        {running > 0 && (
          <button
            onClick={onCommands}
            className="flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-400"
            title={`${running} process${running === 1 ? "" : "es"} started by an agent — click to see or stop`}
          >
            <TerminalSquare className="size-3" />
            {running}
          </button>
        )}
        {/* Opens in the real browser, not in the app: the renderer has no
            navigation of its own, and a docs page loading inside the chat
            window would be a trap with no way back. */}
        <TipButton
          tip="Documentation"
          className="size-7"
          onClick={() => window.maple?.openExternal(DOCS_URL)}
        >
          <CircleHelp className="size-3.5" />
        </TipButton>
      </div>

      {/* Status sits right, and shrinks first: the title is one word and always
          fits, while the message can be a full sentence about a failure. */}
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <ModelPicker backendReady={phase === "ready"} />
        <ContextMeter context={context} />
        {/* Rendered only when there is something to say: an empty span still
            costs two flex gaps, which reads as a hole between the model name
            and the tool count now that the ready state sends no prose. */}
        {message && <span className="truncate">{message}</span>}
        {typeof tools === "number" && (
          <span className="shrink-0 tabular-nums">· {tools} tools</span>
        )}
        <span className={cn("size-2 shrink-0 rounded-full", DOT[phase] ?? DOT.starting)} />
      </div>
    </header>
  );
}

/**
 * How full the model's usable window is.
 *
 * The budget is not the model's advertised context length, which it cannot
 * actually use -- Maple's measured recall of a planted fact falls from 4/4 at
 * 1.5k tokens to 0/4 at 12k. It is the band where the model still remembers
 * what it was told, so "full" here means "about to be summarised", not "about
 * to error", and it comes from the *selected* model rather than a constant.
 * Hidden until a conversation is underway, since a meter reading zero teaches
 * nobody anything.
 */
function ContextMeter({ context }) {
  if (!context?.tokens) return null;
  const pct = Math.min(100, Math.round((context.tokens / context.budget) * 100));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                pct >= 90 ? "bg-amber-500" : "bg-muted-foreground/50",
              )}
              style={{ width: `${Math.max(pct, 4)}%` }}
            />
          </div>
          <span className="tabular-nums">{pct}%</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {context.tokens.toLocaleString()} / {context.budget.toLocaleString()} tokens of
        working context. Older turns are summarised past this.
      </TooltipContent>
    </Tooltip>
  );
}

/** Elapsed mm:ss while recording — a wait that visibly counts. */
function RecordingClock({ startedAt }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return <span className="text-xs tabular-nums text-destructive">{mm}:{ss}</span>;
}
