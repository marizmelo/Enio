import { useEffect, useState } from "react";
import { Brain, Briefcase, MessageSquare, Trash2 } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  conversationKnowledge,
  discardConversation,
  discardConversations,
  listConversations,
} from "@/lib/conversations";
import { listProjects } from "@/lib/projects";

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

/**
 * The conversation picker, and the one dialog in the app with a real decision
 * in it.
 *
 * Discarding shows exactly what was learned from the conversation before
 * anything is deleted, because the facts are what the user would actually
 * miss: the transcript is scrollback, but "you prefer teal" quietly governs
 * future answers. Keep pins those facts so they survive without their
 * transcript — the same standing `enio remember` grants — and Forget deletes
 * them with it. There is no silent default.
 */
export function HistoryDialog({
  open,
  onOpenChange,
  currentId,
  activeProjectId,
  onPick,
  onOpenProject,
  onDiscarded,
}) {
  const [conversations, setConversations] = useState([]);
  // id → name, so a tagged conversation can say which project it belongs to
  // rather than the generic "open project". A deleted project's conversations
  // keep their tag but lose the name — those rows just show no badge.
  const [projectNames, setProjectNames] = useState({});
  // With a project open, its conversations are usually what's wanted — but
  // "all" stays one click away, because the filter must never read as loss.
  const [onlyProject, setOnlyProject] = useState(false);
  // The discard flow: which conversation, and what dies with it.
  const [confirming, setConfirming] = useState(null);
  const [facts, setFacts] = useState([]);
  const [busy, setBusy] = useState(false);
  // Bulk selection. Held as ids across the whole list rather than the visible
  // slice, so searching or switching the project filter never silently drops
  // something you picked -- the confirm step then names every one by title,
  // which is what makes deleting things you cannot currently see safe.
  const [selected, setSelected] = useState(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkError, setBulkError] = useState("");

  useEffect(() => {
    if (open) {
      setOnlyProject(Boolean(activeProjectId));
      listConversations().then(setConversations).catch(() => setConversations([]));
      listProjects()
        .then((all) => setProjectNames(Object.fromEntries(all.map((p) => [p.id, p.name]))))
        .catch(() => setProjectNames({}));
      setSelected(new Set());
      setBulkConfirm(false);
      setBulkError("");
    }
  }, [open, activeProjectId]);

  const shown =
    onlyProject && activeProjectId
      ? conversations.filter((c) => c.projectId === activeProjectId)
      : conversations;

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Every selected conversation, visible or not.
  const chosen = conversations.filter((c) => selected.has(c.id));
  const chosenWithKnowledge = chosen.filter((c) => c.knowledge > 0);
  const chosenFactCount = chosenWithKnowledge.reduce((n, c) => n + c.knowledge, 0);

  const finishBulk = async (keepFacts) => {
    setBusy(true);
    setBulkError("");
    const ids = chosen.map((c) => c.id);
    const { done, failed } = await discardConversations(ids, { keepFacts });
    setConversations((prev) => prev.filter((c) => !done.includes(c.id)));
    for (const id of done) onDiscarded?.(id);
    setBusy(false);
    if (failed.length > 0) {
      // Partial success is reported rather than swallowed: the list already
      // shows what survived, and this says why.
      setSelected(new Set(failed.map((f) => f.id)));
      setBulkError(
        `Deleted ${done.length}. ${failed.length} could not be deleted: ${failed[0].reason}`,
      );
      return;
    }
    setSelected(new Set());
    setBulkConfirm(false);
  };

  const beginDiscard = async (conv) => {
    setConfirming(conv);
    setFacts([]);
    try {
      setFacts(await conversationKnowledge(conv.id));
    } catch {
      /* The dialog still works; it just cannot enumerate the loss. */
    }
  };

  const finishDiscard = async (keepFacts) => {
    if (!confirming) return;
    setBusy(true);
    try {
      await discardConversation(confirming.id, { keepFacts });
      setConversations((prev) => prev.filter((c) => c.id !== confirming.id));
      onDiscarded?.(confirming.id);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  return (
    <>
      <CommandDialog open={open} onOpenChange={onOpenChange} title="Conversations">
        <CommandInput placeholder="Search conversations…" />
        <CommandList>
          <CommandEmpty>No stored conversations.</CommandEmpty>
          {activeProjectId && (
            <div className="flex gap-1 px-3 pt-2 text-xs">
              <button
                className={`rounded-full border px-2 py-0.5 ${onlyProject ? "bg-muted font-medium" : "text-muted-foreground"}`}
                onClick={() => setOnlyProject(true)}
              >
                This project
              </button>
              <button
                className={`rounded-full border px-2 py-0.5 ${onlyProject ? "text-muted-foreground" : "bg-muted font-medium"}`}
                onClick={() => setOnlyProject(false)}
              >
                All
              </button>
            </div>
          )}
          {selected.size > 0 && (
            <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
              <span className="font-medium">
                {selected.size} selected
                {chosenFactCount > 0 && (
                  <span className="ml-1 font-normal text-muted-foreground">
                    · {chosenWithKnowledge.length} taught Enio{" "}
                    {chosenFactCount === 1 ? "1 thing" : `${chosenFactCount} things`}
                  </span>
                )}
              </span>
              <button
                className="ml-auto rounded border px-2 py-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => setSelected(new Set(shown.map((c) => c.id)))}
              >
                Select all
              </button>
              <button
                className="rounded border px-2 py-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </button>
              <button
                className="rounded border border-destructive/40 px-2 py-0.5 text-destructive hover:bg-destructive/10"
                onClick={() => setBulkConfirm(true)}
              >
                Delete
              </button>
            </div>
          )}
          <CommandGroup heading="Conversations">
            {shown.map((c) => (
              <CommandItem
                key={c.id}
                value={`${c.title} ${c.id}`}
                onSelect={() => {
                  onOpenChange(false);
                  if (c.id !== currentId) onPick(c);
                }}
                className="group"
              >
                {/* One slot, two faces: the icon until you hover or start
                    selecting, the box after. Swapping in place is what keeps
                    the rows from shifting sideways the moment the pointer
                    lands. stopPropagation is what separates "select this"
                    from "open this" inside a cmdk item, whose whole job is
                    to fire onSelect when clicked. */}
                <span
                  className="mr-2 flex size-4 shrink-0 items-center justify-center"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(c.id);
                  }}
                >
                  <MessageSquare
                    className={`size-4 text-muted-foreground ${
                      selected.size > 0 ? "hidden" : "group-hover:hidden"
                    }`}
                  />
                  <input
                    type="checkbox"
                    className={`size-3.5 cursor-pointer ${
                      selected.size > 0 ? "" : "hidden group-hover:block"
                    }`}
                    checked={selected.has(c.id)}
                    tabIndex={-1}
                    aria-label={`Select ${c.title}`}
                    // The box deliberately has no handler of its own: a click
                    // on it bubbles to the span above, which is the single
                    // place that both stops cmdk from opening the row and
                    // flips the selection. Handling it here as well made the
                    // box inert -- its stopPropagation beat the span to it.
                    readOnly
                  />
                </span>
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {/* The project a tagged conversation belongs to, by name.
                    For a project this window does not have open, the badge is
                    a button: picking the row resumes the transcript only,
                    while this explicit click re-scopes the sandbox to that
                    project — consent stays a user act. */}
                {c.projectId && projectNames[c.projectId] && (
                  c.projectId !== activeProjectId && onOpenProject ? (
                    <button
                      className="ml-2 flex max-w-32 shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
                      title={`Open this conversation in its project, ${projectNames[c.projectId]}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenChange(false);
                        onOpenProject(c);
                      }}
                    >
                      <Briefcase className="size-2.5 shrink-0" />
                      <span className="truncate">{projectNames[c.projectId]}</span>
                    </button>
                  ) : (
                    <span className="ml-2 flex max-w-32 shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      <Briefcase className="size-2.5 shrink-0" />
                      <span className="truncate">{projectNames[c.projectId]}</span>
                    </span>
                  )
                )}
                {/* Marks the conversations whose deletion would cost something
                    memory keeps. The count is the tooltip, not the label: the
                    scan question is "does this hold anything", answered by the
                    icon being there at all, and a number on every row would be
                    noise on the ones reading 1. */}
                {c.knowledge > 0 && (
                  <Brain
                    className="ml-2 size-3.5 shrink-0 text-emerald-500"
                    title={`Enio learned ${c.knowledge === 1 ? "1 thing" : `${c.knowledge} things`} here`}
                  />
                )}
                <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                  {ago(c.lastAt)}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="ml-1 size-6 shrink-0 opacity-0 group-hover:opacity-100"
                  title="Discard"
                  onClick={(e) => {
                    e.stopPropagation();
                    beginDiscard(c);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>

      {/* The bulk confirm. It names every conversation rather than counting
          them, because selection survives searching and filtering: the list
          here is the only place you can be sure what is about to go. Rows
          that taught Enio something are marked, and the Keep option is the
          same bargain the single-discard dialog offers — knowledge outlives
          its transcript only if you say so. */}
      <Dialog open={bulkConfirm} onOpenChange={(o) => !o && !busy && setBulkConfirm(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {chosen.length === 1 ? "this conversation" : `these ${chosen.length} conversations`}?
            </DialogTitle>
            <DialogDescription>
              The transcripts will be deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <ul className="min-w-0 max-h-48 space-y-1 overflow-y-auto rounded-md border bg-muted/40 p-3 text-sm">
            {chosen.map((c) => (
              <li key={c.id} className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {c.knowledge > 0 && (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-600">
                    <Brain className="size-3" />
                    {c.knowledge}
                  </span>
                )}
              </li>
            ))}
          </ul>

          {chosenFactCount > 0 ? (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {chosenWithKnowledge.length === 1
                  ? "One of these taught Enio something"
                  : `${chosenWithKnowledge.length} of these taught Enio something`}
              </span>{" "}
              — {chosenFactCount === 1 ? "1 fact" : `${chosenFactCount} facts`} in total. Keeping
              that knowledge lets Enio remember it after the transcripts are gone; forgetting
              removes it from memory as well. A fact whose conversation is gone cannot be
              rebuilt by a reindex.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing was learned from these, so only the transcripts go.
            </p>
          )}

          {bulkError && <p className="text-sm text-destructive">{bulkError}</p>}

          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setBulkConfirm(false)}>
              Cancel
            </Button>
            {chosenFactCount > 0 && (
              <Button variant="outline" disabled={busy} onClick={() => finishBulk(true)}>
                Keep knowledge, delete chats
              </Button>
            )}
            <Button variant="destructive" disabled={busy} onClick={() => finishBulk(false)}>
              {busy
                ? "Deleting…"
                : chosenFactCount > 0
                  ? "Forget everything"
                  : `Delete ${chosen.length}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard this conversation?</DialogTitle>
            <DialogDescription>
              “{confirming?.title}” will be deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          {facts.length > 0 ? (
            // min-w-0 on the block: DialogContent is a grid, and a grid child's
            // default min-width is auto, so a long fact stretched the column
            // past the dialog and pushed the footer buttons off-screen. The
            // facts wrap rather than truncate -- they are the thing being
            // decided about, and a decision needs the whole sentence.
            <div className="min-w-0 space-y-2">
              <p className="text-sm font-medium">
                Enio learned {facts.length === 1 ? "this" : `${facts.length} things`} from it:
              </p>
              <ul className="max-h-48 space-y-1.5 overflow-y-auto rounded-md border bg-muted/40 p-3 text-sm">
                {facts.map((f) => (
                  <li key={f.id} className="break-words leading-snug">
                    · {f.text}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                Forgetting removes this knowledge from memory. Keeping it lets Enio
                remember even after the conversation is gone.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing was learned from this conversation, so only the transcript goes.
            </p>
          )}

          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            {facts.length > 0 && (
              <Button variant="outline" disabled={busy} onClick={() => finishDiscard(true)}>
                Keep knowledge, discard chat
              </Button>
            )}
            <Button variant="destructive" disabled={busy} onClick={() => finishDiscard(false)}>
              {facts.length > 0 ? "Forget everything" : "Discard"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
