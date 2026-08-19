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
import { FileViewer } from "@/components/FileViewer";
import { listFiles, removeConversationFiles, removeFile } from "@/lib/recipes";
import { fetchCapabilities } from "@/lib/capabilities";
import { FileTree } from "@/components/ProjectFilesDialog";
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
 * **Remove** deletes it, and is the only one that is not reversible — which
 * is why it exists only for attachments. An attachment is enio's own copy;
 * removing it never touches the file it was copied from. Workspace files are
 * the user's actual work, the server refuses to delete them, and their row
 * offers Finder instead.
 */
export function FilesDialog({ open, onOpenChange, conversationId, onReuse, onOpenInCanvas }) {
  const [data, setData] = useState(null);
  // Two faces of one button. Browse is the tree: every file Enio can reach
  // (project folders, conversation attachments, the workspace), click to
  // open in the canvas to read and edit. Storage is what was here before:
  // what the workspace holds, grouped by conversation, and how to free it.
  // Browse first, because "open a file" is the more common want.
  const [tab, setTab] = useState("browse");
  // The reachable file list, fetched fresh each time the dialog opens: the
  // startup snapshot in capabilities would not show files the agent wrote
  // a minute ago, which is exactly when you want to open them.
  const [tree, setTree] = useState({ files: [], project: null });
  const [treeKey, setTreeKey] = useState(0);
  const [expanded, setExpanded] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  // Which set the arrows walk. Opening from a conversation should step through
  // that conversation, not through every file on disk — so the set is captured
  // at the moment of opening rather than derived from one global list.
  const [viewing, setViewing] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setData(await listFiles());
    } catch (err) {
      setError(String(err?.message ?? err));
    }
    try {
      const caps = await fetchCapabilities();
      setTree({ files: caps.files ?? [], project: caps.project ?? null });
      setTreeKey((k) => k + 1);
    } catch {
      /* the storage tab still works; the tree just shows what it last had */
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

  const row = (file, siblings) => (
    <FileRow
      key={file.path}
      file={file}
      busy={busy === file.path}
      onOpen={() => setViewing({ files: siblings, index: siblings.indexOf(file) })}
      onReuse={() => onReuse([file.path])}
      // Deleting is for attachments — enio's own copies. A workspace file is
      // the user's actual work; the server refuses to delete it, so no button
      // pretends otherwise. Show in Finder is how those are managed.
      onRemove={siblings === workspace ? null : () => drop(file.path)}
    />
  );

  return (
    <>
    {viewing && (
      <FileViewer
        open
        files={viewing.files}
        index={viewing.index}
        onIndex={(index) => setViewing((v) => ({ ...v, index }))}
        onOpenChange={(next) => !next && setViewing(null)}
      />
    )}
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Fixed height on purpose: the dialog used to size itself to content
          and grow as the file list loaded, so every row and the New file
          button moved under the pointer mid-click. A constant frame with the
          list scrolling INSIDE it is what makes a click land where it was
          aimed. */}
      <DialogContent className="flex h-[80vh] flex-col gap-0 sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <DialogTitle>Files</DialogTitle>
            <nav className="flex gap-1 text-xs">
              {[
                ["browse", "Browse"],
                ["storage", "Storage"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={`rounded px-2.5 py-1 ${
                    tab === id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>
          <DialogDescription>
            {tab === "browse"
              ? tree.project
                ? `Every file Enio can reach — ${tree.project.name}'s folders and your workspace. Click one to open it.`
                : "Every file Enio can reach in your workspace. Click one to open it."
              : data
                ? `${size(data.totalBytes)} in your workspace. Attachments are kept with the conversation they belong to.`
                : "Reading the workspace…"}
          </DialogDescription>
        </DialogHeader>

        {tab === "browse" && (
          <div className="mt-3 flex min-h-0 flex-1 flex-col">
            <FileTree
              key={treeKey}
              project={tree.project}
              files={tree.files}
              scope="all"
              pickLabel="open"
              onPick={(path) => {
                onOpenInCanvas?.(path);
                onOpenChange(false);
              }}
            />
          </div>
        )}

        {tab === "storage" && (<div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <section className="mt-4">
          <h3 className="text-xs font-medium text-muted-foreground">This conversation</h3>
          {mine ? (
            <ul className="mt-2 space-y-1">{mine.files.map((f) => row(f, mine.files))}</ul>
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
                      {conv.files.map((f) => row(f, conv.files))}
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
              attached to a conversation. These are your files — enio does not delete
              them; use Show in Finder to manage them.
            </p>
            <ul className="mt-2 space-y-1">{workspace.map((f) => row(f, workspace))}</ul>
          </section>
        )}
        </div>)}
      </DialogContent>
    </Dialog>
    </>
  );
}

function FileRow({ file, busy, onOpen, onReuse, onRemove }) {
  const thumb = useThumbnail(file.image ? file.path : "");

  return (
    <li className="flex items-center gap-2.5 rounded border p-2 text-sm">
      {/* The name and the thumbnail open it. That is what clicking a file
          means everywhere else, and the row's other four actions are icons
          precisely so this one can be the whole rest of the row. */}
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left hover:opacity-80"
        title={`Open ${file.name}`}
      >
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
      </button>
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
      {onRemove && (
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
      )}
    </li>
  );
}
