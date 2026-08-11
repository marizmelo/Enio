import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileQuestion,
  FolderOpen,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { renderMarkdownish } from "@/lib/markdown";
import { cn } from "@/lib/utils";

const size = (bytes) =>
  bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

/**
 * Looking at a file, rather than at a 32px thumbnail of one.
 *
 * One component for both jobs because they are the same job. A gallery is a
 * reader that happens to be showing an image, and the thing that makes either
 * usable is not the rendering — it is that the *set* travels with you. Open a
 * screenshot from a conversation and the arrows walk the rest of that
 * conversation's files; open one from the workspace list and they walk the
 * workspace. Which set was opened is the caller's business, so it passes one.
 *
 * Kind is decided in the main process from the bytes as well as the name,
 * because a .log that turns out to be binary should say so rather than paint a
 * screenful of replacement characters — that reads as a corrupt file rather
 * than as the wrong viewer.
 */
export function FileViewer({ files, index, onIndex, open, onOpenChange }) {
  const [content, setContent] = useState(null);
  const [actualSize, setActualSize] = useState(false);

  const file = files[index] ?? null;
  const path = file?.path ?? file ?? null;

  useEffect(() => {
    if (!open || !path) return undefined;
    let live = true;
    setContent(null);
    setActualSize(false);
    window.maple?.readFilePreview(path).then((next) => {
      if (live) setContent(next ?? { kind: "missing" });
    });
    return () => {
      live = false;
    };
  }, [open, path]);

  const step = useCallback(
    (delta) => {
      if (files.length < 2) return;
      // Wraps, because a gallery that dead-ends at the last image makes you
      // work out where you are before every press.
      onIndex((index + delta + files.length) % files.length);
    },
    [files.length, index, onIndex],
  );

  // Arrow keys, which is how anyone who has used a photo viewer expects to
  // move. Escape is Radix's, already.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, step]);

  if (!file) return null;
  const name = content?.name ?? path.split("/").pop();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[85vh] max-w-[min(92vw,1100px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(92vw,1100px)]"
        // The arrows and the page both want the arrow keys. The viewer wins:
        // scrolling a document is the scrollbar's job and stepping the set is
        // the only thing the keyboard here is for.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium">{name}</DialogTitle>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {files.length > 1 && `${index + 1} of ${files.length} · `}
            {content?.bytes ? size(content.bytes) : ""}
          </span>
          {content?.kind === "image" && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              title={actualSize ? "Fit to window" : "Actual size"}
              onClick={() => setActualSize((v) => !v)}
            >
              {actualSize ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            title="Save a copy…"
            onClick={() => window.maple?.saveFileAs(path)}
          >
            <Download className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="mr-6 size-7 shrink-0"
            title="Show in Finder"
            onClick={() => window.maple?.revealFile(path)}
          >
            <FolderOpen className="size-3.5" />
          </Button>
        </header>

        <div className="relative min-h-0 flex-1">
          <Body content={content} path={path} actualSize={actualSize} />

          {files.length > 1 && (
            <>
              <Step side="left" onClick={() => step(-1)} />
              <Step side="right" onClick={() => step(1)} />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Step({ side, onClick }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Previous file" : "Next file"}
      className={cn(
        "absolute top-1/2 -translate-y-1/2 rounded-full border bg-background/80 p-1.5 shadow-sm backdrop-blur hover:bg-muted",
        side === "left" ? "left-2" : "right-2",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

function Body({ content, path, actualSize }) {
  if (!content) {
    return <Centered>Reading…</Centered>;
  }

  switch (content.kind) {
    case "image":
      return (
        // Checkerboard-free plain surface: a neutral backdrop is what makes a
        // transparent PNG legible without pretending to be an image editor.
        <div className={cn("h-full w-full bg-muted/30", actualSize ? "overflow-auto" : "overflow-hidden")}>
          <div className={cn("flex min-h-full min-w-full items-center justify-center p-4")}>
            <img
              src={content.url}
              alt={content.name}
              className={actualSize ? "max-w-none" : "max-h-full max-w-full object-contain"}
            />
          </div>
        </div>
      );

    case "text":
      return <Reader content={content} />;

    case "pdf":
      return (
        <Centered>
          <FileQuestion className="mb-3 size-8 text-muted-foreground" />
          <p className="text-sm">PDFs open in their own window.</p>
          <Button className="mt-3" size="sm" onClick={() => window.maple?.openPdf(path)}>
            Open {content.name}
          </Button>
          <p className="mt-2 max-w-sm text-center text-xs text-muted-foreground">
            That window has the real viewer — selectable text, search and page navigation —
            which this one would only be imitating.
          </p>
        </Centered>
      );

    case "too-big":
      return (
        <Centered>
          <p className="text-sm">{size(content.bytes)} is too large to show here.</p>
          <p className="mt-1 text-xs text-muted-foreground">Save a copy or open it in Finder.</p>
        </Centered>
      );

    case "binary":
      return (
        <Centered>
          <FileQuestion className="mb-3 size-8 text-muted-foreground" />
          <p className="text-sm">No preview for this kind of file.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {size(content.bytes)} · the agent may still be able to read it.
          </p>
        </Centered>
      );

    case "denied":
      return <Centered>That file is outside the workspace.</Centered>;

    default:
      return <Centered>That file is no longer there.</Centered>;
  }
}

function Centered({ children }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Documents.
 *
 * Three renderings, because a reader that shows everything as one wall of
 * monospace is only a `cat` with a border. Markdown is rendered through the
 * same escaping-first pass the chat uses. Delimited data becomes a table,
 * which is the entire reason anyone opens a CSV. Everything else is code, and
 * code wants a fixed pitch and its line breaks left alone.
 */
function Reader({ content }) {
  const ext = content.name.split(".").pop()?.toLowerCase() ?? "";
  const rows = useMemo(
    () => (ext === "csv" || ext === "tsv" ? parseDelimited(content.text, ext) : null),
    [content.text, ext],
  );

  return (
    <div className="h-full overflow-auto">
      {rows ? (
        <table className="w-full border-collapse text-xs">
          <tbody>
            {rows.map((cells, r) => (
              <tr key={r} className={cn(r === 0 && "sticky top-0 bg-background font-medium")}>
                {cells.map((cell, c) => (
                  <td key={c} className="max-w-[320px] truncate border px-2 py-1" title={cell}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : ext === "md" || ext === "markdown" ? (
        <div
          className="prose-chat px-5 py-4 text-sm leading-relaxed"
          dangerouslySetInnerHTML={{ __html: renderMarkdownish(content.text) }}
        />
      ) : (
        <pre className="px-5 py-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
          {content.text}
        </pre>
      )}

      {content.truncated && (
        <p className="border-t px-5 py-2 text-xs text-muted-foreground">
          Showing the first part of the file. Save a copy to read the rest.
        </p>
      )}
    </div>
  );
}

/**
 * Enough CSV to render a table, and no more.
 *
 * Quoted fields and doubled quotes are handled because they are what a
 * spreadsheet export actually produces; embedded newlines inside quotes are
 * not, and a row cap keeps a 400k-line export from freezing the window. This
 * is a preview — a file that needs a real parser needs a real spreadsheet.
 */
const MAX_ROWS = 500;

function parseDelimited(text, ext) {
  const sep = ext === "tsv" ? "\t" : ",";
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(0, MAX_ROWS)
    .map((line) => {
      const cells = [];
      let cell = "";
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
          if (ch === '"' && line[i + 1] === '"') {
            cell += '"';
            i++;
          } else if (ch === '"') quoted = false;
          else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === sep) {
          cells.push(cell);
          cell = "";
        } else cell += ch;
      }
      cells.push(cell);
      return cells;
    });
}
