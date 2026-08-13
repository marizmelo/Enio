import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, MessageSquareText, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deleteThread, fetchComments, replyThread, resolveThread } from "@/lib/notes";

/**
 * Comment threads anchored to passages of a managed note.
 *
 * Anchors are located server-side on every fetch — quote plus context,
 * relocated through the exact/contextual/fuzzy ladder — so a thread whose
 * text was edited around still points at it, and one whose text is gone
 * shows an honest "passage removed" badge instead of pointing at the
 * wrong sentence. Clicking a quote selects the passage in the editor,
 * which is what "margin comment" means in a pane this narrow; bubbles in
 * an actual margin are recorded as not-built until a real editor
 * component replaces the textarea.
 */
export function NoteComments({ name, rev, onLocate }) {
  const [data, setData] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    fetchComments(name)
      .then(setData)
      .catch((err) => setError(String(err?.message ?? err)));
  }, [name]);

  useEffect(() => {
    refresh();
  }, [refresh, rev]);

  const threads = data?.threads ?? [];
  if (threads.length === 0 && !data?.damaged) return null;

  const act = (id, fn) => async () => {
    setBusy(id);
    setError("");
    try {
      await fn();
      refresh();
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="max-h-[40%] shrink-0 overflow-y-auto border-t">
      <p className="flex items-center gap-1.5 px-3 pt-2 text-[11px] font-medium text-muted-foreground">
        <MessageSquareText className="size-3" />
        Comments · {threads.length}
      </p>
      {data?.damaged && (
        <p className="px-3 py-1 text-[11px] text-destructive">
          The previous comments file was unreadable — it was kept beside the note.
        </p>
      )}
      {error && <p className="px-3 py-1 text-[11px] text-destructive">{error}</p>}
      <ul className="space-y-2 p-2">
        {threads.map((t) => (
          <li key={t.id} className={`rounded border p-2 ${t.resolved ? "opacity-60" : ""}`}>
            <div className="flex items-start gap-1.5">
              {t.orphaned ? (
                <span
                  className="min-w-0 flex-1 truncate text-[11px] italic text-muted-foreground"
                  title="The quoted passage is no longer in the note. Restoring the text re-attaches this thread."
                >
                  “{t.quote}” — passage removed
                </span>
              ) : (
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                  title="Select this passage in the editor"
                  onClick={() => onLocate?.(t.start, t.end)}
                >
                  “{t.quote}”{t.exact === false ? " ≈" : ""}
                </button>
              )}
              <button
                type="button"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                title={t.resolved ? "Reopen" : "Resolve"}
                onClick={act(t.id, () => resolveThread(name, t.id, !t.resolved))}
              >
                {t.resolved ? <Undo2 className="size-3" /> : <Check className="size-3" />}
              </button>
              <button
                type="button"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                title="Delete thread"
                onClick={act(t.id, () => deleteThread(name, t.id))}
              >
                <Trash2 className="size-3" />
              </button>
            </div>
            <ul className="mt-1.5 space-y-1">
              {t.messages.map((m, i) => (
                <li key={i} className="text-xs leading-relaxed">
                  <span className={m.role === "ai" ? "font-medium text-primary" : "font-medium"}>
                    {m.role === "ai" ? "AI" : "You"}:
                  </span>{" "}
                  {m.text}
                </li>
              ))}
            </ul>
            {!t.resolved && (
              <form
                className="mt-1.5 flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const text = (drafts[t.id] ?? "").trim();
                  if (!text || busy) return;
                  setDrafts((d) => ({ ...d, [t.id]: "" }));
                  act(t.id, () => replyThread(name, t.id, text))();
                }}
              >
                <input
                  value={drafts[t.id] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                  placeholder="Reply — the AI answers in-thread"
                  className="h-6 min-w-0 flex-1 rounded border bg-transparent px-2 text-xs outline-none"
                />
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" type="submit" disabled={!!busy}>
                  {busy === t.id ? <Loader2 className="size-3 animate-spin" /> : "Send"}
                </Button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
