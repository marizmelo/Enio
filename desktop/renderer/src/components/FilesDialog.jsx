import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Download, FileText, FolderOpen, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useThumbnail } from "@/components/AttachmentChips";
import { listFiles, removeConversationFiles, removeFile } from "@/lib/recipes";
import { cn } from "@/lib/utils";

const size = (bytes) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : bytes >= 1e6
      ? `${(bytes / 1e6).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

/**
 * Everything the workspace is holding, and a way to get rid of it.
 *
 * Attachments are grouped by the conversation they were attached to, which is
 * the only grouping that answers the question anyone actually has about them:
 * not "what is this file" but "do I still need it". A flat list of
 * screenshot-7.png tells you nothing; the same file under the question it was
 * asked with tells you everything.
 *
 * Four things can be done with a file and they are deliberately different
 * verbs. **Reuse** puts it back in the composer as a mention — that is what
 * makes an old attachment worth keeping. **Save a copy** writes it out through
 * the system panel, because the workspace is not where anyone keeps their
 * files. **Reveal** opens Finder for everything this dialog does not do.
 * **Remove** deletes it, and is the only one that is not reversible.
 */
export function FilesDialog({ open, onOpenChange, conversationId, onReuse }) {
  const [data, setData] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async () => {
    try {
      setData(await listFiles());
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

  const drop = async (path) => {
    setBusy(path);
    setError("");
    try {
      await removeFile(path);
      await refresh();
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy("");
    }
  };

  const dropConversation = async (id) => {
    setBusy(id);
    setError("");
    try {
      await removeConversationFiles(id);
      await refresh();
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy("");
    }
  };

  const conversations = data?.conversations ?? [];
  // This conversation first and always open: it is the one the person is in,
  // and scrolling past four other threads to reach it would be backwards.
  const mine = conversations.find((c) => c.id === conversationId);
  const others = conversations.filter((c) => c.id !== conversationId);
  const workspace = data?.workspace ?? [];

  const row = (file, { canReuse }) => (
    <FileRow
      key={file.path}
      file={file}
      busy={busy === file.path}
      onReuse={canReuse ? () => onReuse([file.path]) : null}
      onRemove={() => drop(file.path)}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] gap-0 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Files</DialogTitle>
          <DialogDescription>
            {data
              ? `${size(data.totalBytes)} in your workspace. Attachments are kept with the conversation they belong to.`
              : "Reading the workspace…"}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <section className="mt-4">
          <h3 className="text-xs font-medium text-muted-foreground">This conversation</h3>
          {mine ? (
            <ul className="mt-2 space-y-1">{mine.files.map((f) => row(f, { canReuse: true }))}</ul>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              Nothing attached yet. Files you attach here stay with this conversation.
            </p>
          )}
        </section>

        {others.length > 0 && (
          <section className="mt-6">
            <h3 className="text-xs font-medium text-muted-foreground">Other conversations</h3>
            <ul className="mt-2 space-y-1">
              {others.map((conv) => (
                <li key={conv.id} className="rounded border">
                  <div className="flex items-center gap-2 p-2 text-sm">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() =>
                        setExpanded((prev) => ({ ...prev, [conv.id]: !prev[conv.id] }))
                      }
                    >
                      <ChevronRight
                        className={cn(
                          "size-3.5 shrink-0 text-muted-foreground transition-transform",
                          expanded[conv.id] && "rotate-90",
                        )}
                      />
                      {/* A discarded conversation still has its files listed.
                          Hiding them would leave disk in use that nothing on
                          screen accounts for, and this is now the only place
                          they can be found at all. */}
                      <span
                        className={cn(
                          "truncate",
                          conv.title === null && "italic text-muted-foreground",
                        )}
                      >
                        {conv.title ?? "discarded conversation"}
                      </span>
                    </button>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {conv.files.length} · {size(conv.bytes)}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 shrink-0"
                      disabled={busy === conv.id}
                      title="Remove all of this conversation's files"
                      onClick={() => dropConversation(conv.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                  {expanded[conv.id] && (
                    <ul className="space-y-1 border-t p-2">
                      {conv.files.map((f) => row(f, { canReuse: true }))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {workspace.length > 0 && (
          <section className="mt-6">
            <h3 className="text-xs font-medium text-muted-foreground">Workspace</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Files you or the agent put in <code>~/enio-workspace</code>, rather than
              attached to a conversation.
            </p>
            <ul className="mt-2 space-y-1">{workspace.map((f) => row(f, { canReuse: true }))}</ul>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FileRow({ file, busy, onReuse, onRemove }) {
  const thumb = useThumbnail(file.image ? file.path : "");

  return (
    <li className="flex items-center gap-2.5 rounded border p-2 text-sm">
      {thumb ? (
        <img src={thumb} alt="" className="size-9 shrink-0 rounded object-cover" />
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center rounded bg-muted">
          <FileText className="size-4 text-muted-foreground" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{file.name}</span>
        <span className="block text-xs text-muted-foreground tabular-nums">
          {size(file.bytes)}
        </span>
      </span>
      {onReuse && (
        <Button
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          title="Attach to the message being written"
          onClick={onReuse}
        >
          <Plus className="size-3.5" />
        </Button>
      )}
      <Button
        size="icon"
        variant="ghost"
        className="size-7 shrink-0"
        title="Save a copy…"
        onClick={() => window.maple?.saveFileAs(file.path)}
      >
        <Download className="size-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7 shrink-0"
        title="Show in Finder"
        onClick={() => window.maple?.revealFile(file.path)}
      >
        <FolderOpen className="size-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7 shrink-0"
        disabled={busy}
        title={`Delete ${file.name}`}
        onClick={onRemove}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </li>
  );
}
