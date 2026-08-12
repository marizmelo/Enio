import { useEffect, useMemo, useState } from "react";
import { ChevronRight, CornerLeftUp, File, Folder, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { isImageName } from "@/lib/capabilities";

/**
 * Browsing the open project's files.
 *
 * This replaces a nested dropdown submenu, which was the wrong shape twice
 * over: one attached folder here holds 327 files, so the menu truncated and
 * buried the documents behind three hundred images, and a menu cannot be
 * searched or walked into. A modal can do both.
 *
 * The tree is derived from the flat alias-prefixed listing the server already
 * sends -- no new endpoint, and no risk of showing a path the agent cannot
 * address, because these *are* the paths it addresses.
 */
export function ProjectFilesDialog({ open, onOpenChange, project, files = [], onPick }) {
  // Current location as path segments, starting at the virtual root that
  // holds the attachment aliases.
  const [path, setPath] = useState([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) {
      setPath([]);
      setQuery("");
    }
  }, [open]);

  const aliases = useMemo(
    () => new Set((project?.attachments ?? []).map((a) => a.alias)),
    [project],
  );

  // Only the project's own files; the workspace has its own menu entry.
  const projectFiles = useMemo(
    () => files.filter((f) => aliases.has(f.split("/")[0])),
    [files, aliases],
  );

  // Searching is global on purpose: "where is my resume" should not depend on
  // standing in the right folder first.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return projectFiles.filter((f) => f.toLowerCase().includes(q)).slice(0, 200);
  }, [query, projectFiles]);

  // Immediate children of the current path, folders before files.
  const { folders, here } = useMemo(() => {
    const prefix = path.length > 0 ? path.join("/") + "/" : "";
    const folderNames = new Set();
    const fileNames = [];
    for (const f of projectFiles) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) fileNames.push(rest);
      else folderNames.add(rest.slice(0, slash));
    }
    return { folders: [...folderNames].sort(), here: fileNames.sort() };
  }, [projectFiles, path]);

  const currentPath = path.join("/");
  const noteFor = (alias) =>
    (project?.attachments ?? []).find((a) => a.alias === alias)?.note ?? "";

  const pick = (fullPath) => {
    onPick?.(fullPath);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Files in {project?.name ?? "this project"}</DialogTitle>
          <DialogDescription>
            Pick a file to attach it to your message, or attach a whole folder so Enio can
            search inside it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-md border px-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none"
            placeholder="Search all project files…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {/* Breadcrumbs double as the way back up: a modal with no visible
            location is one you get lost in. */}
        {!results && (
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <button
              className={path.length === 0 ? "text-foreground" : "hover:text-foreground"}
              onClick={() => setPath([])}
            >
              {project?.name ?? "Project"}
            </button>
            {path.map((seg, i) => (
              <span key={i} className="flex items-center gap-1">
                <ChevronRight className="size-3" />
                <button
                  className={i === path.length - 1 ? "text-foreground" : "hover:text-foreground"}
                  onClick={() => setPath(path.slice(0, i + 1))}
                >
                  {seg}
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="min-h-40 flex-1 overflow-y-auto rounded-md border">
          {results ? (
            results.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">Nothing matches “{query}”.</p>
            ) : (
              results.map((f) => (
                <Row key={f} icon={<FileIcon name={f} />} label={f} onClick={() => pick(f)} />
              ))
            )
          ) : (
            <>
              {path.length > 0 && (
                <Row
                  icon={<CornerLeftUp className="size-4 text-muted-foreground" />}
                  label="Back"
                  onClick={() => setPath(path.slice(0, -1))}
                />
              )}
              {folders.map((d) => {
                const full = [...path, d].join("/");
                return (
                  <Row
                    key={full}
                    icon={<Folder className="size-4 text-muted-foreground" />}
                    label={d}
                    // At the root these are the attachments, so their notes --
                    // the user's own "what this is for" -- belong here.
                    hint={path.length === 0 ? noteFor(d) : ""}
                    trailing={<ChevronRight className="size-3.5 text-muted-foreground" />}
                    onClick={() => setPath([...path, d])}
                  />
                );
              })}
              {here.map((f) => {
                const full = [...path, f].join("/");
                return (
                  <Row
                    key={full}
                    icon={<FileIcon name={f} />}
                    label={f}
                    onClick={() => pick(full)}
                  />
                );
              })}
              {folders.length === 0 && here.length === 0 && (
                <p className="p-3 text-xs text-muted-foreground">This folder is empty.</p>
              )}
            </>
          )}
        </div>

        {/* Attaching the folder itself is often the better answer: Enio can
            list and search inside it rather than being handed one file. */}
        {!results && path.length > 0 && (
          <Button variant="outline" size="sm" className="self-start" onClick={() => pick(currentPath)}>
            <Folder className="size-3.5" /> Attach “{path[path.length - 1]}” as a folder
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({ icon, label, hint, trailing, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 border-b px-3 py-1.5 text-left last:border-b-0 hover:bg-muted"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{label}</span>
      {hint && <span className="max-w-40 shrink-0 truncate text-[11px] text-muted-foreground">{hint}</span>}
      {trailing}
    </button>
  );
}

function FileIcon({ name }) {
  return isImageName(name) ? (
    <File className="size-4 text-blue-500/70" />
  ) : (
    <File className="size-4 text-muted-foreground" />
  );
}
