import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppWindow,
  Copy,
  Eye,
  FolderOpen,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Save,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { renderMarkdownish } from "@/lib/markdown";
import { NoteComments } from "@/components/NoteComments";
import { createThread, transformSelection } from "@/lib/notes";
import { readSkillSource, saveSkillSource } from "@/lib/skills";

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
 * system considers its editor, and Reveal reaches Finder's full Open With
 * menu. A "Google Docs" button was built and removed: without a real
 * integration it was copy-and-paste wearing a logo, and a button that
 * implies a connection Enio does not have is a small lie. The honest form
 * of that idea is an MCP connection, when one exists.
 */

const MEDIA = /\.(png|jpe?g|gif|webp|bmp|avif|svg|mp4|mov|webm|mp3|m4a|wav)$/i;
const VIDEO = /\.(mp4|mov|webm)$/i;
const AUDIO = /\.(mp3|m4a|wav)$/i;
const MARKDOWN = /\.(md|markdown)$/i;

export function CanvasPanel({ path, rev, full, onToggleFull, onClose, onDiscarded, className, hotkeys = true }) {
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

  // --- selection verbs + managed-note state --------------------------------
  const textareaRef = useRef(null);
  const [sel, setSel] = useState({ start: 0, end: 0 });
  // idle | working | preview — the verb result is PREVIEWED, never spliced
  // straight in: a 4B rewrite varies, and a bad one must cost a glance.
  const [transform, setTransform] = useState(null);
  const [verbError, setVerbError] = useState("");
  const [rewriteAsk, setRewriteAsk] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [discussAsk, setDiscussAsk] = useState(false);
  const [question, setQuestion] = useState("");
  const [commentsRev, setCommentsRev] = useState(0);
  // One-deep undo for accepted transforms: programmatic setBuffer breaks the
  // native textarea undo everywhere in this panel already, so an explicit
  // snapshot is the honest answer (the PlanWidget precedent).
  const undoRef = useRef(null);
  const [canUndo, setCanUndo] = useState(false);

  const isNote = path.startsWith(".notes/");
  const noteName = isNote ? path.slice(".notes/".length) : null;
  // A skill's SKILL.md, opened from the Skills panel. Not a workspace path:
  // skills live in enio's own data dir, so this prefix is a handle the panel
  // resolves over the API rather than through the workspace IPC — which is
  // what keeps the canvas's write reach exactly where it was.
  const isSkill = path.startsWith(".skill/");
  const skillName = isSkill ? path.slice(".skill/".length) : null;
  const [skillDir, setSkillDir] = useState("");

  /** Select and reveal a range in the editor — what a margin click means here. */
  const locateRange = (start, end) => {
    const area = textareaRef.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(start, end);
    // Approximate scroll: proportional position is close enough to bring
    // the selection into view in a monospace textarea.
    area.scrollTop = Math.max(0, (start / Math.max(1, area.value.length)) * area.scrollHeight - 80);
    setSel({ start, end });
  };

  const runVerb = async (verb) => {
    const area = textareaRef.current;
    if (!area) return;
    const start = area.selectionStart ?? 0;
    const end = area.selectionEnd ?? 0;
    setVerbError("");
    setRewriteAsk(false);
    setDiscussAsk(false);
    setTransform({ status: "working", verb, start, end });
    try {
      const { replacement } = await transformSelection({
        text: buffer,
        start,
        end,
        verb,
        instruction: verb === "rewrite" ? instruction : undefined,
      });
      setTransform({ status: "preview", verb, start, end, replacement });
    } catch (err) {
      setTransform(null);
      setVerbError(String(err?.message ?? err));
    }
  };

  const acceptTransform = () => {
    if (transform?.status !== "preview") return;
    const { start, end, replacement, verb } = transform;
    undoRef.current = buffer;
    setCanUndo(true);
    // Continue inserts at the cursor (the server collapsed the range to its
    // end); the other verbs replace the selection.
    const from = verb === "continue" ? end : start;
    setBuffer(buffer.slice(0, from) + replacement + buffer.slice(end));
    setDirty(true);
    setTransform(null);
    setInstruction("");
    requestAnimationFrame(() => locateRange(from, from + replacement.length));
  };

  const undoTransform = () => {
    if (undoRef.current === null) return;
    setBuffer(undoRef.current);
    setDirty(true);
    undoRef.current = null;
    setCanUndo(false);
  };

  const startDiscuss = async () => {
    const area = textareaRef.current;
    if (!area || !noteName) return;
    const start = area.selectionStart ?? 0;
    const end = area.selectionEnd ?? 0;
    if (start === end) {
      setVerbError("Select the text to discuss first.");
      return;
    }
    setVerbError("");
    setDiscussAsk(false);
    setTransform({ status: "working", verb: "discuss", start, end });
    try {
      await createThread(noteName, {
        quote: buffer.slice(start, end),
        prefix: buffer.slice(Math.max(0, start - 40), start),
        suffix: buffer.slice(end, end + 40),
        question: question.trim() || undefined,
      });
      setQuestion("");
      setCommentsRev((r) => r + 1);
      setTransform(null);
    } catch (err) {
      setTransform(null);
      setVerbError(String(err?.message ?? err));
    }
  };

  const load = useCallback(async ({ clobber }) => {
    setError("");
    if (isSkill) {
      try {
        const data = await readSkillSource(skillName);
        setKind("text");
        setReadOnly(false);
        setSkillDir(data.dir ?? "");
        if (clobber || !dirtyRef.current) {
          setBuffer(data.content ?? "");
          setDirty(false);
          setBanner(false);
        } else {
          setBanner(true);
        }
        diskMtime.current = data.mtime ?? 0;
      } catch (err) {
        setKind("missing");
        setBlockedNote(String(err?.message ?? err));
      }
      return;
    }
    if (MEDIA.test(path)) {
      const url = await window.maple?.readMedia?.(path);
      if (url) {
        setKind("media");
        setMediaUrl(url);
      } else if (!(await window.maple?.statFile?.(path))) {
        setKind("missing");
        setBlockedNote("This file was deleted or moved. Ask for it again to recreate it.");
        return;
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
    if (!content || content.kind === "missing") {
      // Deleted or moved since the chip was made. Every file action needs
      // bytes on disk, so the panel says what happened and offers nothing
      // it cannot do.
      setKind("missing");
      setBlockedNote("This file was deleted or moved. Ask for it again to recreate it.");
      return;
    }
    if (content.kind === "denied") {
      setKind("blocked");
      setBlockedNote("That file is outside what Enio can reach from here.");
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
  }, [path, isSkill, skillName]);

  // Load on open and whenever the agent rewrites the pinned path (rev bump).
  useEffect(() => {
    setPreview(false);
    setConfirmDiscard(false);
    load({ clobber: false });
  }, [path, rev, load]);

  // A fresh note opens with its placeholder title selected, so typing names
  // it — which is the answer to "how do I rename a note": the first line is
  // the name, and this makes that discoverable without a dialog. One-shot
  // per path; a deliberate return to the untitled text is left alone.
  const titledRef = useRef(null);
  useEffect(() => {
    if (!isNote || kind !== "text" || titledRef.current === path) return;
    const m = /^# (Untitled note)\b/.exec(buffer);
    if (!m) return;
    titledRef.current = path;
    const area = textareaRef.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(2, 2 + m[1].length);
  }, [isNote, kind, buffer, path]);

  // The external-edit loop: TextEdit, VS Code, anything — a save there shows
  // up here within ~2s. Clean buffer reloads silently; dirty buffer gets the
  // same banner an agent rewrite does.
  useEffect(() => {
    // Skills live outside the workspace, so statFile cannot see them and the
    // external-edit loop does not apply: the panel is the editor for those.
    if (isSkill) return undefined;
    const timer = setInterval(async () => {
      const stat = await window.maple?.statFile?.(path);
      if (!stat) return;
      if (diskMtime.current && stat.mtime > diskMtime.current) {
        diskMtime.current = stat.mtime;
        if (dirtyRef.current) setBanner(true);
        else load({ clobber: true });
      } else if (!diskMtime.current) {
        // The file appeared after opening on a missing path -- recreated by
        // the agent or put back from the Trash. Pick it up.
        load({ clobber: false });
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [path, load, isSkill]);

  const flash = (text) => {
    setToast(text);
    setTimeout(() => setToast(""), 3000);
  };

  // ⌘S / Ctrl+S saves the buffer — the reflex every editor honors. Routed
  // through a ref so the listener registers once yet always calls the
  // current save; preventDefault fires even when clean, because the
  // browser's own "save page" dialog is never the right answer here.
  const saveRef = useRef(null);
  useEffect(() => {
    // Two panels can be mounted at once — a pinned document behind the Skills
    // dialog's editor — and both listening on window would make one keystroke
    // save two different files.
    if (!hotkeys) return undefined;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        saveRef.current?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkeys]);

  const save = async () => {
    if (isSkill) {
      try {
        const out = await saveSkillSource(skillName, buffer);
        setDirty(false);
        setBanner(false);
        diskMtime.current = out.mtime ?? 0;
        return true;
      } catch (err) {
        // The refusal is the useful part: a save that would break the
        // frontmatter is rejected server-side, with the reason.
        setError(String(err?.message ?? err));
        return false;
      }
    }
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

  // Refreshed every render: the shortcut saves only what the Save button
  // would — an editable, dirty buffer — and is inert otherwise.
  saveRef.current = kind === "text" && !readOnly && dirty ? save : null;

  /** The disk is always the copy's source: a dirty buffer is saved first, so
   *  what lands elsewhere is what the canvas shows. */
  const saveCopy = async () => {
    if (kind === "text" && dirty && !(await save())) return;
    await window.maple?.saveFileAs?.(path);
  };

  const discard = async () => {
    const result = await window.maple?.trashFile?.(path);
    if (result?.ok) {
      // A note's comments go with it. Sidecar failure is a toastable shrug:
      // an orphaned comments file beside a trashed note harms nothing.
      if (isNote) await window.maple?.trashFile?.(`${path}.comments.json`).catch(() => {});
      onDiscarded();
    } else {
      setError(result?.reason ?? "Could not move it to the Trash.");
    }
  };

  const name = path.split("/").pop();
  // A skill's handle carries no extension, but a SKILL.md is markdown — so
  // Preview (and the verbs, which are on every text file already) applies.
  const isMarkdown = MARKDOWN.test(path) || isSkill;
  const editable = kind === "text" && !readOnly;
  // A note is shown by its TITLE — the first heading, live from the buffer —
  // because the filename is a stable internal id, not a name. Renaming a
  // note IS editing its first line; the list and this header follow.
  const noteTitle = isNote
    ? /^#\s+(.+)$/m.exec(buffer)?.[1]?.trim() || name.replace(/\.md$/, "")
    : null;

  return (
    <div className={`flex flex-col bg-background ${className ?? ""}`}>
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {isNote ? noteTitle : isSkill ? skillName : name}
            {dirty && <span className="ml-1.5 text-muted-foreground">•</span>}
          </p>
          {/* The real home. "Generated inside Enio" is still a normal file in
              a normal folder — this line plus Reveal is what makes that
              legible, and what makes Trash's Put Back make sense. A managed
              note is the one exception: never revealing the path IS the
              convention that keeps external editors out of .notes/, which is
              what keeps comment anchors trustworthy. */}
          {isNote ? (
            <p className="block max-w-full truncate text-[10px] text-muted-foreground">
              Managed note — the first line is its name · export with Save a copy
            </p>
          ) : isSkill ? (
            /* The real folder, because a skill IS a folder — references and
               scripts live beside the SKILL.md and Finder is how you add
               them. The frontmatter warning is here rather than in a toast:
               it is a property of the document, not of one save. */
            <button
              className="block max-w-full truncate text-[10px] text-muted-foreground hover:underline"
              title="Show in Finder"
              onClick={() => window.maple?.revealFoundFile?.(skillDir)}
              disabled={!skillDir}
            >
              Skill — keep the --- block at the top · show the folder in Finder
            </button>
          ) : (
            <button
              className="block max-w-full truncate text-[10px] text-muted-foreground hover:underline"
              title="Show in Finder"
              onClick={() => window.maple?.revealFile?.(path)}
            >
              {path.includes("/") ? (
                <span className="font-mono">{path}</span>
              ) : (
                "in your workspace — show in Finder"
              )}
            </button>
          )}
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
        {/* The whole window, or the split beside the thread. Writing wants
            the width; steering the agent wants the chat — one click apart. */}
        {onToggleFull && (
          <button
            className="shrink-0 text-muted-foreground hover:text-foreground"
            title={full ? "Show the conversation" : "Fullscreen"}
            onClick={onToggleFull}
          >
            {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
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

      {/* Selection verbs: bounded transforms on the highlighted range — a
          closed list, one model call each, previewed before anything lands.
          On every text file; Discuss needs the managed store, so it is
          visible-but-disabled elsewhere: the boundary stated, not hidden. */}
      {editable && !preview && (
        <div className="shrink-0 border-b px-2 py-1">
          <div className="flex flex-wrap items-center gap-1">
            {[
              ["tighten", "Tighten", "Say the same thing in fewer words"],
              ["expand", "Expand", "Develop the selection with more detail"],
            ].map(([verb, label, tip]) => (
              <Button
                key={verb}
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                title={tip}
                disabled={sel.start === sel.end || transform?.status === "working"}
                onClick={() => runVerb(verb)}
              >
                {label}
              </Button>
            ))}
            <Button
              size="sm"
              variant={rewriteAsk ? "secondary" : "ghost"}
              className="h-6 px-2 text-xs"
              title="Rewrite the selection to an instruction"
              disabled={sel.start === sel.end || transform?.status === "working"}
              onClick={() => setRewriteAsk((v) => !v)}
            >
              Rewrite…
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              title="Write what naturally follows the cursor"
              disabled={transform?.status === "working"}
              onClick={() => runVerb("continue")}
            >
              Continue
            </Button>
            <Button
              size="sm"
              variant={discussAsk ? "secondary" : "ghost"}
              className="h-6 px-2 text-xs"
              title={
                isNote
                  ? "Open a comment thread on the selection — the AI answers in it"
                  : "Comments live in Notes — this file isn't a note."
              }
              disabled={!isNote || sel.start === sel.end || transform?.status === "working"}
              onClick={() => setDiscussAsk((v) => !v)}
            >
              Discuss
            </Button>
            {transform?.status === "working" && (
              <Loader2 className="ml-1 size-3.5 animate-spin text-muted-foreground" />
            )}
            {canUndo && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 gap-1 px-2 text-xs text-muted-foreground"
                title="Undo the last accepted edit"
                onClick={undoTransform}
              >
                <Undo2 className="size-3" /> Undo
              </Button>
            )}
          </div>
          {rewriteAsk && (
            <form
              className="flex items-center gap-1.5 px-1 pb-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (instruction.trim()) runVerb("rewrite");
              }}
            >
              <input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="How should it change? e.g. turn it into bullets"
                autoFocus
                className="h-6 min-w-0 flex-1 rounded border bg-transparent px-2 text-xs outline-none"
              />
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" type="submit">
                Go
              </Button>
            </form>
          )}
          {discussAsk && (
            <form
              className="flex items-center gap-1.5 px-1 pb-1"
              onSubmit={(e) => {
                e.preventDefault();
                startDiscuss();
              }}
            >
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask about the selection (optional)"
                autoFocus
                className="h-6 min-w-0 flex-1 rounded border bg-transparent px-2 text-xs outline-none"
              />
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" type="submit">
                Start thread
              </Button>
            </form>
          )}
          {verbError && <p className="px-1 pb-1 text-[11px] text-destructive">{verbError}</p>}
        </div>
      )}

      {/* The preview between verb and buffer: what came back, next to what
          it replaces, and nothing changes until Accept. */}
      {transform?.status === "preview" && (
        <div className="shrink-0 space-y-1.5 border-b bg-muted/30 px-3 py-2">
          {transform.verb !== "continue" && (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Selected
              </p>
              <p className="max-h-24 overflow-y-auto whitespace-pre-wrap font-mono text-xs opacity-70">
                {buffer.slice(transform.start, transform.end)}
              </p>
            </div>
          )}
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {transform.verb === "continue" ? "Continuation" : "Replacement"}
            </p>
            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-xs">
              {transform.replacement}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" className="h-6 px-2.5 text-xs" onClick={acceptTransform}>
              Accept
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => setTransform(null)}
            >
              Reject
            </Button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {kind === "text" && !preview && (
          <textarea
            ref={textareaRef}
            className="h-full w-full resize-none bg-transparent p-3 font-mono text-xs leading-relaxed outline-none"
            value={buffer}
            readOnly={readOnly}
            spellCheck={false}
            onSelect={(e) =>
              setSel({ start: e.target.selectionStart ?? 0, end: e.target.selectionEnd ?? 0 })
            }
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
        {(kind === "blocked" || kind === "missing") && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm font-medium">{name}</p>
            <p className="text-xs text-muted-foreground">{blockedNote}</p>
          </div>
        )}
      </div>

      {isNote && kind === "text" && (
        <NoteComments name={noteName} rev={`${commentsRev}:${rev}`} onLocate={locateRange} />
      )}

      {kind !== "missing" && (
      <footer className="flex shrink-0 flex-wrap items-center gap-1.5 border-t px-3 py-2">
        {editable && (
          <Button size="sm" className="h-7 gap-1 px-2.5 text-xs" disabled={!dirty} onClick={save}>
            <Save className="size-3.5" /> Save
          </Button>
        )}
        {/* Desktop entries are always real; web apps join this menu when a
            connection that can actually receive the file exists -- a button
            implying an integration Enio does not have would be a small lie,
            which is why the clipboard-to-docs.new version was removed.
            Hidden for managed notes: handing a note to an external editor is
            exactly what the .notes/ convention exists to prevent. Hidden for
            skills because every entry here takes a workspace path, and a
            skill is not in the workspace -- the header's Finder link is the
            one that resolves. */}
        {!isNote && !isSkill && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs">
              <AppWindow className="size-3.5" /> Open with…
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56">
            <DropdownMenuItem onSelect={() => window.maple?.openInDefaultApp?.(path)}>
              Default app
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => window.maple?.openWithApp?.(path)}>
              Choose an app…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => window.maple?.revealFile?.(path)}>
              Show in Finder
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
              Web apps appear here when a connection can receive this file.
            </DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>
        )}
        {kind === "text" && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-xs"
            title="Copy the whole document — e.g. to paste into a web app"
            onClick={async () => {
              await window.maple?.copyText?.(buffer);
              flash("Copied.");
            }}
          >
            <Copy className="size-3.5" /> Copy
          </Button>
        )}
        {/* Both act through workspace-scoped IPC, which cannot see a skill --
            and discarding a skill from an editor is the wrong door for it
            anyway: deleting know-how should be a deliberate act in Finder. */}
        {!isSkill && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-xs"
            onClick={saveCopy}
          >
            <FolderOpen className="size-3.5" /> Save a copy…
          </Button>
        )}
        <span className="flex-1" />
        {isSkill ? null : confirmDiscard ? (
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
      )}
    </div>
  );
}
