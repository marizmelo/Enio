import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { deleteRecipe, listRecipes, saveRecipe } from "@/lib/recipes";

const BLANK = { name: "", summary: "", script: "" };

/**
 * The recipe list, and the one place a person curates what the model can pick.
 *
 * Recipes exist because the model cannot reliably write AppleScript but can
 * reliably choose from a short list. That makes the *contents* of the list the
 * thing that decides what the agent can do — so it has to be readable and
 * editable by the person, not only appendable by the approval flow.
 *
 * Built-ins are shown but locked. They are code, and a list you can only see
 * half of cannot be curated; seeing the script is the honest answer to "what
 * does this actually do".
 *
 * Saving runs the script first and refuses to store one that failed. That is
 * the same rule approving a plan obeys, and it is not belt-and-braces: a
 * recipe is *selected* from then on rather than re-authored, so one that never
 * worked would be re-run verbatim forever, failing identically, with nothing
 * positioned to notice.
 */
export function RecipesDialog({ open, onOpenChange }) {
  const [builtin, setBuiltin] = useState([]);
  const [saved, setSaved] = useState([]);
  const [canRun, setCanRun] = useState(true);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [output, setOutput] = useState("");

  const refresh = useCallback(async () => {
    try {
      const data = await listRecipes();
      setBuiltin(data.builtin ?? []);
      setSaved(data.saved ?? []);
      setCanRun(data.desktopActions !== false);
    } catch {
      setBuiltin([]);
      setSaved([]);
    }
  }, []);

  useEffect(() => {
    if (open) {
      refresh();
      setEditing(null);
      setError("");
      setOutput("");
    }
  }, [open, refresh]);

  const commit = async () => {
    setBusy(true);
    setError("");
    setOutput("");
    try {
      const res = await saveRecipe(editing.name, {
        summary: editing.summary,
        script: editing.script,
      });
      setOutput(res.ran ? `Ran successfully.\n${res.output ?? ""}`.trim() : "Saved.");
      setEditing(null);
      await refresh();
    } catch (err) {
      // The script's own failure is the useful part, not the status code.
      setError(err?.detail ? `${err.message}\n\n${err.detail}` : String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name) => {
    setBusy(true);
    try {
      await deleteRecipe(name);
      await refresh();
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Recipes</DialogTitle>
          <DialogDescription>
            Tested scripts the agent picks by name instead of writing from scratch.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-1">
          {!canRun && (
            <p className="mb-3 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              Saved recipes need desktop mode to run or be saved. Start enio with{" "}
              <code className="rounded bg-muted px-1">ENIO_DESKTOP=1</code>.
            </p>
          )}

          {editing ? (
            <div className="flex flex-col gap-2">
              <input
                autoFocus
                value={editing.name}
                disabled={editing.existing}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="short_name"
                className="h-9 rounded-md border bg-background px-2 font-mono text-sm disabled:opacity-60"
              />
              <input
                value={editing.summary}
                onChange={(e) => setEditing({ ...editing, summary: e.target.value })}
                placeholder="What it does, in a few words — the agent reads this to choose it"
                className="h-9 rounded-md border bg-background px-2 text-sm"
              />
              <textarea
                value={editing.script}
                onChange={(e) => setEditing({ ...editing, script: e.target.value })}
                placeholder={'tell application "Notes" to get name of notes 1 thru 5'}
                spellCheck={false}
                className="min-h-[180px] rounded-md border bg-muted px-2 py-1.5 font-mono text-[12px] leading-relaxed"
              />
              <p className="text-xs text-muted-foreground">
                Saving runs it once. If it fails it is not saved — a recipe that never
                worked would be re-run exactly the same way every time after.
              </p>
            </div>
          ) : (
            <>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Yours</p>
              {saved.length === 0 ? (
                <p className="mb-4 text-xs text-muted-foreground">
                  None yet. Approve a plan and choose “Save as recipe”, or write one here.
                </p>
              ) : (
                <ul className="mb-4 flex flex-col gap-1.5">
                  {saved.map((r) => (
                    <li key={r.name} className="rounded-md border px-3 py-2">
                      <div className="flex items-center gap-2">
                        <code className="text-xs">{r.name}</code>
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                          {r.summary}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setEditing({ ...r, existing: true })}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => remove(r.name)}
                          aria-label={`Delete ${r.name}`}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Built in — always available, not editable</p>
              <ul className="flex flex-col gap-1.5">
                {builtin.map((r) => (
                  <li
                    key={r.name}
                    title="Built into enio — the agent can always use this; it just can't be edited here."
                    className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2"
                  >
                    <code className="text-xs">{r.name}</code>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {r.summary}
                    </span>
                    {r.needsApp && (
                      <Badge variant="secondary" className="text-[10px]">
                        needs app
                      </Badge>
                    )}
                    {/* Withheld from the agent entirely until macOS allows the
                        read, so saying so here explains an absence the user
                        would otherwise have to guess at. */}
                    {!r.available && (
                      <Badge variant="secondary" className="text-[10px]">
                        needs Accessibility
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          {error && (
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
              {error}
            </pre>
          )}
          {output && !editing && (
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md border px-3 py-2 text-xs text-muted-foreground">
              {output}
            </pre>
          )}
        </div>

        <DialogFooter>
          {editing ? (
            <div className="flex gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button
                disabled={busy || !editing.name.trim() || !editing.summary.trim() || !editing.script.trim()}
                onClick={commit}
              >
                {busy ? "Running…" : "Test and save"}
              </Button>
            </div>
          ) : (
            <Button variant="outline" disabled={!canRun} onClick={() => setEditing({ ...BLANK })}>
              <Plus className="mr-1 size-3.5" />
              New recipe
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
