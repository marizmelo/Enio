import { useEffect, useState } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
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
  listConversations,
} from "@/lib/conversations";

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
export function HistoryDialog({ open, onOpenChange, currentId, onPick, onDiscarded }) {
  const [conversations, setConversations] = useState([]);
  // The discard flow: which conversation, and what dies with it.
  const [confirming, setConfirming] = useState(null);
  const [facts, setFacts] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) listConversations().then(setConversations).catch(() => setConversations([]));
  }, [open]);

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
          <CommandGroup heading="Conversations">
            {conversations.map((c) => (
              <CommandItem
                key={c.id}
                value={`${c.title} ${c.id}`}
                onSelect={() => {
                  onOpenChange(false);
                  if (c.id !== currentId) onPick(c);
                }}
                className="group"
              >
                <MessageSquare className="mr-2 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
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

      <Dialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard this conversation?</DialogTitle>
            <DialogDescription>
              “{confirming?.title}” will be deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          {facts.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                Enio learned {facts.length === 1 ? "this" : `${facts.length} things`} from it:
              </p>
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-muted/40 p-3 text-sm">
                {facts.map((f) => (
                  <li key={f.id} className="truncate">
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
