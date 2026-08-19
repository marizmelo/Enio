import { useCallback, useEffect, useState } from "react";
import { ChevronRight, FolderPlus, MessageSquarePlus, Plus, SquareArrowOutUpRight, Trash2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  CAPS,
  attachToProject,
  createProject,
  deleteProject,
  detachFromProject,
  getProject,
  listProjects,
  openProject,
  updateProject,
} from "@/lib/projects";

const TYPES = ["general", "code", "planning"];

/** Live remaining-characters, red once the server would refuse. */
function Counter({ value, cap }) {
  const left = cap - (value?.length ?? 0);
  return (
    <span className={`text-[11px] tabular-nums ${left < 0 ? "text-destructive" : "text-muted-foreground"}`}>
      {left}
    </span>
  );
}

/**
 * Projects: name, type, description, instructions, and attachments with
 * notes. Everything here is context the agent carries on every turn of a
 * project conversation — the counters exist because the fields are hard
 * capped server-side (small models, small context) and a refusal should be
 * visible while typing, not after a round-trip.
 */
export function ProjectsDialog({ open, onOpenChange, activeId, onOpened, onClosed, onStartChat }) {
  const [projects, setProjects] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [detail, setDetail] = useState(null); // fields being edited
  const [creating, setCreating] = useState(false);
  // Paths picked but not yet attached: each gets its note written first,
  // because the note is the whole point — "what is this for" is what the
  // agent reads.
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    if (open) {
      refresh();
      setError("");
      setEditingId(null);
      setDetail(null);
      setCreating(false);
      setPending([]);
    }
  }, [open, refresh]);

  const beginEdit = async (p) => {
    setError("");
    setPending([]);
    try {
      const full = await getProject(p.id);
      setEditingId(p.id);
      setDetail(full);
    } catch (err) {
      setError(String(err?.message ?? err));
    }
  };

  const saveDetail = async (patch) => {
    setBusy(true);
    setError("");
    try {
      const next = await updateProject(editingId, patch);
      setDetail(next);
      await refresh();
      return true;
    } catch (err) {
      setError(String(err?.message ?? err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const pickPaths = async () => {
    const paths = (await window.maple?.pickProjectPaths()) ?? [];
    if (paths.length > 0) {
      setPending((prev) => [...prev, ...paths.map((path) => ({ path, note: "" }))]);
    }
  };

  const attachPending = async () => {
    setBusy(true);
    setError("");
    try {
      for (const item of pending) {
        await attachToProject(editingId, item.path, item.note);
      }
      setPending([]);
      const next = await getProject(editingId);
      setDetail(next);
      await refresh();
    } catch (err) {
      // Attach one at a time so a refused path names itself; the rest stay
      // pending rather than being silently dropped.
      setError(String(err?.message ?? err));
      const next = await getProject(editingId).catch(() => null);
      if (next) {
        setDetail(next);
        setPending((prev) => prev.filter((i) => !next.attachments.some((a) => a.path === i.path)));
      }
    } finally {
      setBusy(false);
    }
  };

  const editor = detail && (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <input
          className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-sm"
          value={detail.name}
          maxLength={CAPS.name}
          onChange={(e) => setDetail({ ...detail, name: e.target.value })}
          onBlur={() => saveDetail({ name: detail.name })}
        />
        <select
          className="rounded-md border bg-transparent px-2 py-1 text-xs"
          value={detail.type}
          onChange={async (e) => {
            const type = e.target.value;
            setDetail({ ...detail, type });
            await saveDetail({ type });
          }}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span className="flex items-center justify-between">
          What is this project about?
          <Counter value={detail.description} cap={CAPS.description} />
        </span>
        <input
          className="rounded-md border bg-transparent px-2 py-1 text-sm text-foreground"
          value={detail.description}
          placeholder="One line — the agent reads this every turn"
          onChange={(e) => setDetail({ ...detail, description: e.target.value })}
          onBlur={() => saveDetail({ description: detail.description })}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span className="flex items-center justify-between">
          Instructions — how should Enio work here?
          <Counter value={detail.instructions} cap={CAPS.instructions} />
        </span>
        <Textarea
          className="min-h-16 text-sm"
          value={detail.instructions}
          placeholder="Short standing instructions. Capped so they always fit the model's context."
          onChange={(e) => setDetail({ ...detail, instructions: e.target.value })}
          onBlur={() => saveDetail({ instructions: detail.instructions })}
        />
      </label>

      {/* What the harness runs after the agent edits code here. Blank means
          auto-detect from the attached repo. Refused at save if it names a
          command the shell would not run -- the error lands below like any
          other, so a typo is a message rather than a silent never-runs. */}
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span className="flex items-center justify-between">
          Verify command — run after the agent edits code
          <Counter value={detail.verifyCommand ?? ""} cap={CAPS.verifyCommand} />
        </span>
        <input
          className="rounded-md border bg-transparent px-2 py-1.5 font-mono text-sm"
          value={detail.verifyCommand ?? ""}
          placeholder="Leave blank to auto-detect (npm test, tsc, cargo check, go build, pytest)"
          maxLength={CAPS.verifyCommand}
          onChange={(e) => setDetail({ ...detail, verifyCommand: e.target.value })}
          onBlur={() => saveDetail({ verifyCommand: detail.verifyCommand ?? "" })}
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="flex items-center justify-between text-xs text-muted-foreground">
          Attached files and folders
          <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-xs" onClick={pickPaths}>
            <FolderPlus className="size-3" /> Add…
          </Button>
        </span>

        {detail.attachments.length === 0 && pending.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Nothing attached. Attach the folders and files this project is about — each can
            carry a note saying what it is for.
          </p>
        )}

        {detail.attachments.map((a) => (
          <div key={a.alias} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
            <code className="shrink-0 text-xs">{a.alias}{a.kind === "folder" ? "/" : ""}</code>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {a.note || a.path}
            </span>
            <button
              className="shrink-0 text-muted-foreground hover:text-foreground"
              title="Show in Finder"
              onClick={() => window.maple?.revealProjectPath(a.path)}
            >
              <SquareArrowOutUpRight className="size-3.5" />
            </button>
            <button
              className="shrink-0 text-muted-foreground hover:text-destructive"
              title="Detach (the files themselves are untouched)"
              onClick={async () => {
                setBusy(true);
                try {
                  await detachFromProject(editingId, a.alias);
                  const next = await getProject(editingId);
                  setDetail(next);
                  await refresh();
                } catch (err) {
                  setError(String(err?.message ?? err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}

        {pending.map((item, i) => (
          <div key={item.path} className="flex items-center gap-2 rounded-md border border-dashed px-2 py-1.5">
            <span className="min-w-0 shrink truncate text-xs">{item.path}</span>
            <input
              className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 text-xs"
              placeholder="What is this for? (optional)"
              value={item.note}
              maxLength={CAPS.note}
              onChange={(e) =>
                setPending((prev) =>
                  prev.map((p, j) => (j === i ? { ...p, note: e.target.value } : p)),
                )
              }
            />
            <button
              className="shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
        {pending.length > 0 && (
          <Button size="sm" className="self-end" disabled={busy} onClick={attachPending}>
            Attach {pending.length === 1 ? "it" : `all ${pending.length}`}
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between border-t pt-3">
        <Button
          size="sm"
          variant="ghost"
          className="gap-1 text-destructive"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await deleteProject(editingId);
              if (editingId === activeId) onClosed?.();
              setEditingId(null);
              setDetail(null);
              await refresh();
            } catch (err) {
              setError(String(err?.message ?? err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Trash2 className="size-3.5" /> Delete project
        </Button>
        {/* The way out of the editor is forward, into a conversation — the
            create → attach → edit flow used to dead-end here, with "Open"
            stranded back on the list. */}
        <div className="flex items-center gap-2">
          {editingId !== activeId && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await openProject(editingId);
                  onOpened?.();
                } catch (err) {
                  setError(String(err?.message ?? err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Open
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={() => onStartChat?.(editingId)}>
            <MessageSquarePlus className="size-3.5" /> Start a conversation
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Projects</DialogTitle>
          <DialogDescription>
            A project gives Enio standing context: what you're working on, how to help, and
            which files and folders matter. It shapes every conversation opened under it.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {editingId ? (
          <>
            <button
              className="self-start text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                setEditingId(null);
                setDetail(null);
                setPending([]);
              }}
            >
              ← All projects
            </button>
            {editor}
          </>
        ) : (
          <div className="flex flex-col gap-1.5">
            {projects.map((p) => (
              <div key={p.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                <button
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => beginEdit(p)}
                >
                  <ChevronRight className="size-3 shrink-0" />
                  <span className="shrink-0 text-sm">{p.name}</span>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {p.type}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {p.description || `${p.attachments} attached`}
                  </span>
                </button>
                {p.id === activeId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs"
                    disabled={busy}
                    onClick={async () => {
                      const { closeProject } = await import("@/lib/projects");
                      await closeProject().catch(() => {});
                      onClosed?.();
                    }}
                  >
                    Close
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="h-6 px-2 text-xs"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        await openProject(p.id);
                        onOpened?.(p);
                      } catch (err) {
                        setError(String(err?.message ?? err));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Open
                  </Button>
                )}
              </div>
            ))}

            {creating ? (
              <NewProjectRow
                busy={busy}
                onCancel={() => setCreating(false)}
                onCreate={async (fields) => {
                  setBusy(true);
                  setError("");
                  try {
                    const created = await createProject(fields);
                    setCreating(false);
                    await refresh();
                    // Straight into the editor: a project with nothing
                    // attached and no instructions is not done being made.
                    setEditingId(created.id);
                    setDetail(created);
                  } catch (err) {
                    setError(String(err?.message ?? err));
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="mt-1 gap-1 self-start"
                onClick={() => setCreating(true)}
              >
                <Plus className="size-3.5" /> New project
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewProjectRow({ busy, onCancel, onCreate }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("general");
  return (
    <form
      className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onCreate({ name: name.trim(), type });
      }}
    >
      <input
        autoFocus
        className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-sm"
        placeholder="Project name"
        value={name}
        maxLength={CAPS.name}
        onChange={(e) => setName(e.target.value)}
      />
      <select
        className="rounded-md border bg-transparent px-2 py-1 text-xs"
        value={type}
        onChange={(e) => setType(e.target.value)}
      >
        {TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <Button size="sm" type="submit" disabled={busy || !name.trim()}>
        Create
      </Button>
      <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}
