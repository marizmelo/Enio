import { useCallback, useEffect, useState } from "react";
import { Disc, NotebookPen, Plus } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { listMeetingFiles } from "@/lib/meetings";
import { createNote, listNotes } from "@/lib/notes";

/**
 * The note collection — the first "section as an app".
 *
 * A list, a New button, and nothing else: the note itself opens in the
 * canvas, where the editing surface already lives. New note creates and
 * opens immediately with no name prompt — the title is the H1, edited
 * where the text is, because a naming dialog before an empty page is a
 * speed bump in front of nothing.
 */
const ago = (ts) => {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export function NotesDialog({ open, onOpenChange, onOpen }) {
  const [notes, setNotes] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    listNotes()
      .then((d) => setNotes(d.notes ?? []))
      .catch((err) => setError(String(err?.message ?? err)));
    // Meetings ride the same panel: both are things enio wrote down for
    // you. A failed list degrades to an absent section, never an error
    // blocking the notes above it.
    listMeetingFiles()
      .then((m) => setMeetings(m ?? []))
      .catch(() => setMeetings([]));
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const openNote = (path) => {
    onOpenChange(false);
    onOpen(path);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[70vh] w-[28rem] flex-col gap-0 overflow-hidden p-0">
        <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
          <NotebookPen className="size-4 text-muted-foreground" />
          <DialogTitle className="flex-1 text-sm font-medium">Notes</DialogTitle>
          <Button
            size="sm"
            className="h-7 gap-1 px-2.5 text-xs"
            onClick={async () => {
              try {
                const { note } = await createNote();
                openNote(`.notes/${note.name}`);
              } catch (err) {
                setError(String(err?.message ?? err));
              }
            }}
          >
            <Plus className="size-3.5" /> New note
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error && <p className="px-2 py-1 text-xs text-destructive">{error}</p>}
          {notes && notes.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No notes yet. New note opens one in the canvas — the first line is its title.
            </p>
          )}
          <ul className="space-y-0.5">
            {(notes ?? []).map((n) => (
              <li key={n.name}>
                <button
                  type="button"
                  onClick={() => openNote(`.notes/${n.name}`)}
                  className="flex w-full items-baseline gap-2 rounded px-2.5 py-1.5 text-left text-sm hover:bg-muted"
                >
                  <span className="min-w-0 flex-1 truncate">{n.title}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{ago(n.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>

          {meetings.length > 0 && (
            <>
              <p className="flex items-center gap-1.5 px-2.5 pt-3 pb-1 text-[11px] font-medium text-muted-foreground">
                <Disc className="size-3" /> Meetings
              </p>
              <ul className="space-y-0.5">
                {meetings.map((m) => (
                  <li key={m.name}>
                    <button
                      type="button"
                      onClick={() => openNote(m.name)}
                      className="flex w-full items-baseline gap-2 rounded px-2.5 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {m.topic ?? "Meeting"}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {m.when ?? ago(m.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
