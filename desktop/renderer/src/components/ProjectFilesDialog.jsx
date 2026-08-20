import { useEffect, useMemo, useState } from "react";
import { ChevronRight, CornerLeftUp, File, FilePlus, Folder, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { isImageName } from "@/lib/capabilities";
import { childrenAt, groupRoots } from "@/lib/filetree";

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
/**
 * The tree itself, as a panel. Two homes: the composer's attach flow (pick
 * → attach to the message) and the Files dialog's Browse tab (pick → open
 * in the canvas to read and edit). Same derivation, same search, same
 * breadcrumbs; only what a pick MEANS differs, and the caller says which.
 * `scope` widens it past the project: "all" shows workspace files too,
 * which is what browsing (as opposed to attaching project context) wants.
 */
export function FileTree({ project, files = [], generated = [], onPick, pickLabel = "attach", scope = "project", autoFocus = true }) {
  // Current location as path segments, starting at the virtual root that
  // holds the attachment aliases.
  const [path, setPath] = useState([]);
  const [query, setQuery] = useState("");
  // The New file affordance (open mode only): null closed, "" typing.
  const [newName, setNewName] = useState(null);
  const [createError, setCreateError] = useState("");

  const aliases = useMemo(
    () => new Set((project?.attachments ?? []).map((a) => a.alias)),
    [project],
  );

  // Project scope: only the project's own files (the composer's attach menu
  // has a separate workspace entry). All: everything the server lists --
  // project mounts, conversation mounts, workspace -- the whole reachable set.
  const shown = useMemo(
    () => (scope === "all" ? files : files.filter((f) => aliases.has(f.split("/")[0]))),
    [files, aliases, scope],
  );

  // Searching is global on purpose: "where is my resume" should not depend on
  // standing in the right folder first.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return shown.filter((f) => f.toLowerCase().includes(q)).slice(0, 200);
  }, [query, shown]);

  // Immediate children of the current path, folders before files. Derived in
  // lib/filetree.js, which the Node suite tests: an attached folder going
  // missing is exactly the kind of failure nothing throws on.
  const { folders, here } = useMemo(
    () => childrenAt(shown, project?.attachments ?? [], path),
    [shown, path, project],
  );

  const currentPath = path.join("/");
  const noteFor = (alias) =>
    (project?.attachments ?? []).find((a) => a.alias === alias)?.note ?? "";
  const rootLabel = scope === "all" ? "Everything" : (project?.name ?? "Project");

  // Project-first at the root: with a project open, its attached folders and
  // its generated files come first under their own heading, and the
  // workspace follows under another -- one tree, so search still spans
  // everything, but the project is what you see when you arrive.
  const grouped = useMemo(() => {
    if (!project || scope !== "all" || path.length > 0) return null;
    return groupRoots({
      folders,
      here,
      files,
      attachments: project?.attachments ?? [],
      generated,
    });
  }, [project, scope, path, folders, here, generated, files]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2 rounded-md border px-2">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus={autoFocus}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none"
          placeholder={scope === "all" ? "Search all files…" : "Search all project files…"}
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
            {rootLabel}
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
              <Row key={f} icon={<FileIcon name={f} />} label={f} onClick={() => onPick?.(f)} />
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
            {(grouped
              ? [
                  { heading: project?.name ?? "Project", folders: grouped.projectFolders, files: grouped.projectHere },
                  { heading: "Workspace", folders: grouped.wsFolders, files: grouped.wsHere },
                ]
              : [{ heading: null, folders, files: here }]
            ).map(({ heading, folders: fs, files: hs }) =>
              heading !== null && fs.length === 0 && hs.length === 0 ? null : (
                <div key={heading ?? "flat"}>
                  {heading !== null && (
                    <p className="border-b bg-muted/40 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {heading}
                    </p>
                  )}
                  {fs.map((d) => {
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
                  {hs.map((f) => {
                    const full = [...path, f].join("/");
                    return (
                      <Row
                        key={full}
                        icon={<FileIcon name={f} />}
                        label={f}
                        onClick={() => onPick?.(full)}
                      />
                    );
                  })}
                </div>
              ),
            )}
            {folders.length === 0 && here.length === 0 && (
              <p className="p-3 text-xs text-muted-foreground">This folder is empty.</p>
            )}
          </>
        )}
      </div>

      {/* Attaching the folder itself is often the better answer: Enio can
          list and search inside it rather than being handed one file. Only
          in attach mode -- a folder cannot be opened in the canvas. */}
      {pickLabel === "attach" && !results && path.length > 0 && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => onPick?.(currentPath)}>
          <Folder className="size-3.5" /> Attach “{path[path.length - 1]}” as a folder
        </Button>
      )}

      {/* New file, in open mode: created empty by an explicit user act (the
          one sanctioned exception to "the canvas edits, it never mints"),
          then opened in the canvas to write. A subpath like src/new.ts is
          fine -- folders are made on the way, the same rule write_file
          follows. Creation is rooted in the CURRENT folder, so what you see
          in the breadcrumb is where the file lands. */}
      {pickLabel === "open" && !results && (
        newName === null ? (
          <Button variant="outline" size="sm" className="self-start" onClick={() => { setNewName(""); setCreateError(""); }}>
            <FilePlus className="size-3.5" /> New file{path.length > 0 ? ` in ${path[path.length - 1]}` : ""}
          </Button>
        ) : (
          <form
            className="flex items-center gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const name = newName.trim().replace(/^\/+/, "");
              if (!name) return;
              const full = [...path, name].join("/");
              const result = await window.maple?.createFile?.(full);
              if (result?.ok) {
                setNewName(null);
                onPick?.(full);
              } else {
                setCreateError(result?.reason ?? "Could not create the file.");
              }
            }}
          >
            <input
              autoFocus
              className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
              placeholder={`name.ts — created in ${path.length > 0 ? currentPath : "the workspace"}`}
              value={newName}
              onChange={(e) => { setNewName(e.target.value); setCreateError(""); }}
              onKeyDown={(e) => e.key === "Escape" && setNewName(null)}
            />
            <Button size="sm" type="submit" disabled={!newName.trim()}>Create</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setNewName(null)}>Cancel</Button>
          </form>
        )
      )}
      {createError && <p className="text-xs text-destructive">{createError}</p>}
    </div>
  );
}

export function ProjectFilesDialog({ open, onOpenChange, project, files = [], onPick }) {
  // Keyed on open so the tree resets to the root each time it is shown.
  const [openCount, setOpenCount] = useState(0);
  useEffect(() => {
    if (open) setOpenCount((n) => n + 1);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] flex-col gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Files in {project?.name ?? "this project"}</DialogTitle>
          <DialogDescription>
            Pick a file to attach it to your message, or attach a whole folder so Enio can
            search inside it.
          </DialogDescription>
        </DialogHeader>
        <FileTree
          key={openCount}
          project={project}
          files={files}
          pickLabel="attach"
          onPick={(p) => {
            onPick?.(p);
            onOpenChange(false);
          }}
        />
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
