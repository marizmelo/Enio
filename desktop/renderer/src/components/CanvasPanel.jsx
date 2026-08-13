import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppWindow,
  Eye,
  FolderOpen,
  Pencil,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { renderMarkdownish } from "@/lib/markdown";

/**
 * The canvas: a generated file, pinned beside the conversation.
 *
 * The panel exists because "Wrote 2481 bytes to resume.md" is a sentence,
 * not a document. It shows the actual file — editable in place for text,
 * rendered for media — and stays until the user saves a copy somewhere,
 * discards it, or closes it. The disk is the shared state: the agent, this
 * editor, and any external app the user hands the file to all read and
 * write the same path, and a two-second mtime poll is what keeps them one
 * loop.
 *
 * Editing is deliberately shared with real editors rather than replacing
 * them: Save writes back, "Open in app" hands the file to whatever the
 * system considers its editor, Reveal reaches Finder's full Open With menu,
 * and the Google Docs handoff copies the buffer and opens docs.new — an
 * honest no-auth bridge (a real upload needs OAuth, deferred).
 */

const MEDIA = /\.(png|jpe?g|gif|webp|bmp|avif|svg|mp4|mov|webm|mp3|m4a|wav)$/i;
const VIDEO = /\.(mp4|mov|webm)$/i;
const AUDIO = /\.(mp3|m4a|wav)$/i;
const MARKDOWN = /\.(md|markdown)$/i;

export function CanvasPanel({ path, rev, onClose, onDiscarded, className }) {
  const [kind, setKind] = useState("loading"); // loading|text|media|blocked
  const [buffer, setBuffer] = useState("");
  const [dirty, setDirty] = useState(false);
  const [mediaUrl, setMediaUrl] = useState(null);
  const [blockedNote, setBlockedNote] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [preview, setPreview] = useState(false);
  const [banner, setBanner] = useState(false);
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [toast, setToast] = useState("");
  // What the panel last loaded from disk, so the poll can tell "the file
  // moved on" apart from "my own save landed".
  const diskMtime = useRef(0);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const load = useCallback(async ({ clobber }) => {
    setError("");
    if (MEDIA.test(path)) {
      const url = await window.maple?.readMedia?.(path);
      if (url) {
        setKind("media");
        setMediaUrl(url);
      } else {
        // Too big or unreadable: the panel degrades to the handoff actions,
        // never to a blank.
        setKind("blocked");
        setBlockedNote("Too large to preview here — open it in an app instead.");
      }
      const stat = await window.maple?.statFile?.(path);
      if (stat) diskMtime.current = stat.mtime;
      return;
    }
    const content = await window.maple?.readFilePreview?.(path);
    if (!content || content.kind === "missing" || content.kind === "denied") {
      setKind("blocked");
      setBlockedNote("That file is no longer readable from here.");
      return;
    }
    if (content.kind !== "text") {
      setKind("blocked");
      setBlockedNote("Not a text file — open it in an app instead.");
      return;
    }
    setKind("text");
    // Saving a 512KB prefix over a larger file would silently destroy the
    // tail — the one way this panel could lose data, so it refuses to edit.
    setReadOnly(content.truncated === true);
    if (clobber || !dirtyRef.current) {
      setBuffer(content.text ?? "");
      setDirty(false);
      setBanner(false);
    } else {
      setBanner(true);
    }
    const stat = await window.maple?.statFile?.(path);
    if (stat) diskMtime.current = stat.mtime;
  }, [path]);

  // Load on open and whenever the agent rewrites the pinned path (rev bump).
  useEffect(() => {
    setPreview(false);
    setConfirmDiscard(false);
    load({ clobber: false });
  }, [path, rev, load]);

  // The external-edit loop: TextEdit, VS Code, anything — a save there shows
  // up here within ~2s. Clean buffer reloads silently; dirty buffer gets the
  // same banner an agent rewrite does.
  useEffect(() => {
    const timer = setInterval(async () => {
      const stat = await window.maple?.statFile?.(path);
      if (!stat) return;
      if (diskMtime.current && stat.mtime > diskMtime.current) {
        diskMtime.current = stat.mtime;
        if (dirtyRef.current) setBanner(true);
        else load({ clobber: true });
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [path, load]);

  const flash = (text) => {
    setToast(text);
    setTimeout(() => setToast(""), 3000);
  };

  const save = async () => {
    const result = await window.maple?.saveFileContent?.(path, buffer);
    if (result?.ok) {
      setDirty(false);
      setBanner(false);
      const stat = await window.maple?.statFile?.(path);
      if (stat) diskMtime.current = stat.mtime;
      return true;
    }
    setError(result?.reason ?? "Could not save.");
    return false;
  };

  /** The disk is always the copy's source: a dirty buffer is saved first, so
   *  what lands elsewhere is what the canvas shows. */
  const saveCopy = async () => {
    if (kind === "text" && dirty && !(await save())) return;
    await window.maple?.saveFileAs?.(path);
  };

  const discard = async () => {
    const result = await window.maple?.trashFile?.(path);
    if (result?.ok) onDiscarded();
    else setError(result?.reason ?? "Could not move it to the Trash.");
  };

  const toDocs = async () => {
    await window.maple?.copyText?.(buffer);
    window.maple?.openExternal?.("https://docs.new");
    flash("Copied — paste into the new doc.");
  };

  const name = path.split("/").pop();
  const isMarkdown = MARKDOWN.test(path);
  const editable = kind === "text" && !readOnly;

  return (
    <div className={`flex flex-col bg-background ${className ?? ""}`}>
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {name}
            {dirty && <span className="ml-1.5 text-muted-foreground">•</span>}
          </p>
          {/* The real home. "Generated inside Enio" is still a normal file in
              a normal folder — this line plus Reveal is what makes that
              legible, and what makes Trash's Put Back make sense. */}
          <button
            className="block max-w-full truncate font-mono text-[10px] text-muted-foreground hover:underline"
            title="Show in Finder"
            onClick={() => window.maple?.revealFile?.(path)}
          >
            {path}
          </button>
        </div>
        {kind === "text" && isMarkdown && (
          <Button
            size="sm"
            variant={preview ? "secondary" : "ghost"}
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => setPreview((p) => !p)}
          >
            {preview ? <Pencil className="size-3.5" /> : <Eye className="size-3.5" />}
            {preview ? "Edit" : "Preview"}
          </Button>
        )}
        <button
          className="shrink-0 text-muted-foreground hover:text-foreground"
          title="Close (the file stays)"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </header>

      {banner && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/60 px-3 py-1.5 text-xs">
          <span className="min-w-0 flex-1">The file changed on disk while you were editing.</span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => load({ clobber: true })}>
            Reload
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setBanner(false)}>
            Keep mine
          </Button>
        </div>
      )}
      {error && <p className="shrink-0 border-b px-3 py-1.5 text-xs text-destructive">{error}</p>}
      {toast && <p className="shrink-0 border-b px-3 py-1.5 text-xs text-muted-foreground">{toast}</p>}
      {readOnly && kind === "text" && (
        <p className="shrink-0 border-b px-3 py-1.5 text-xs text-muted-foreground">
          Too large to edit here safely — shown read-only. Open it in an app to edit.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {kind === "text" && !preview && (
          <textarea
            className="h-full w-full resize-none bg-transparent p-3 font-mono text-xs leading-relaxed outline-none"
            value={buffer}
            readOnly={readOnly}
            spellCheck={false}
            onChange={(e) => {
              setBuffer(e.target.value);
              setDirty(true);
            }}
          />
        )}
        {kind === "text" && preview && (
          <div
            className="prose-chat p-4 text-sm leading-relaxed"
            dangerouslySetInnerHTML={{ __html: renderMarkdownish(buffer) }}
          />
        )}
        {kind === "media" && VIDEO.test(path) && (
          <video controls src={mediaUrl} className="h-full w-full object-contain p-2" />
        )}
        {kind === "media" && AUDIO.test(path) && (
          <div className="flex h-full items-center justify-center p-4">
            <audio controls src={mediaUrl} className="w-full" />
          </div>
        )}
        {kind === "media" && !VIDEO.test(path) && !AUDIO.test(path) && (
          <div className="flex h-full items-center justify-center p-3">
            <img src={mediaUrl} alt={name} className="max-h-full max-w-full object-contain" />
          </div>
        )}
        {kind === "blocked" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm font-medium">{name}</p>
            <p className="text-xs text-muted-foreground">{blockedNote}</p>
          </div>
        )}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-1.5 border-t px-3 py-2">
        {editable && (
          <Button size="sm" className="h-7 gap-1 px-2.5 text-xs" disabled={!dirty} onClick={save}>
            <Save className="size-3.5" /> Save
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          title="Open in the system's default app — for other apps, use the path above to reveal in Finder and pick Open With"
          onClick={() => window.maple?.openInDefaultApp?.(path)}
        >
          <AppWindow className="size-3.5" /> Open in app
        </Button>
        {kind === "text" && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            title="Copies the document and opens a new Google Doc to paste into"
            onClick={toDocs}
          >
            Google Docs
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          onClick={saveCopy}
        >
          <FolderOpen className="size-3.5" /> Save a copy…
        </Button>
        <span className="flex-1" />
        {confirmDiscard ? (
          <Button
            size="sm"
            variant="destructive"
            className="h-7 gap-1 px-2 text-xs"
            onBlur={() => setConfirmDiscard(false)}
            onClick={discard}
          >
            <Trash2 className="size-3.5" /> Move to Trash?
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            title="Moves the file to the macOS Trash — Put Back restores it"
            onClick={() => setConfirmDiscard(true)}
          >
            <Trash2 className="size-3.5" /> Discard
          </Button>
        )}
      </footer>
    </div>
  );
}
