import { useEffect, useState } from "react";
import { AlertTriangle, BookOpen, FolderOpen } from "lucide-react";
import { listSkills, resetSkill } from "@/lib/skills";

/**
 * The Skills panel: the know-how Enio has, made visible and editable.
 *
 * A row shows what is installed, whether it gets used, and where it lives;
 * clicking one opens its SKILL.md in the canvas, which is already the app's
 * editor for markdown. Creating and deleting stay out — a skill is a folder
 * the user owns, and Finder is the honest door for that — but editing had no
 * business being a trip to Finder when the editor was one panel away.
 */

function ago(ts) {
  if (!ts) return null;
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

export function SkillsPanel({ open, onEdit }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [rev, setRev] = useState(0);
  const [confirmReset, setConfirmReset] = useState(null);

  useEffect(() => {
    if (!open) return;
    setConfirmReset(null);
    listSkills()
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((err) => setError(String(err?.message ?? err)));
  }, [open, rev]);

  const skills = data?.skills ?? [];
  const unresolved = data?.unresolved ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
        {error && <p className="p-3 text-xs text-destructive">{error}</p>}
        {data && skills.length === 0 && !error && (
          <p className="p-3 text-xs text-muted-foreground">
            No skills installed yet. A skill is a markdown file that teaches Enio how you want
            something done — create one with <code>enio skills --new</code>.
          </p>
        )}
        {skills.map((s) =>
          s.broken ? (
            <div
              key={s.dir}
              className="flex items-start gap-2 border-b px-3 py-2 text-destructive last:border-b-0"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <button
                className="min-w-0 flex-1 text-left"
                title="Open it in the editor and fix it"
                onClick={() => onEdit?.(s.name)}
              >
                <span className="text-sm">{s.name}</span>
                <p className="text-xs opacity-80">{s.reason}</p>
              </button>
              <button
                className="shrink-0 text-muted-foreground hover:text-foreground"
                title="Show in Finder"
                onClick={() => window.maple?.revealFoundFile?.(s.dir)}
              >
                <FolderOpen className="size-3.5" />
              </button>
            </div>
          ) : (
            <div key={s.dir} className="flex items-start gap-2 border-b px-3 py-2 last:border-b-0 hover:bg-muted">
              <BookOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <button
                className="min-w-0 flex-1 text-left"
                title="Open it in the editor"
                onClick={() => onEdit?.(s.name)}
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm">{s.name}</span>
                  {s.origin === "project" && (
                    <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                      project
                    </span>
                  )}
                  {s.origin === "builtin" && (
                    <span
                      className="rounded bg-muted px-1 text-[10px] text-muted-foreground"
                      title="Ships with Enio — updates when you update Enio. Editing it makes your own copy."
                    >
                      built-in
                    </span>
                  )}
                  {s.overridesBuiltin && (
                    <span
                      className="rounded bg-muted px-1 text-[10px] text-muted-foreground"
                      title="Your edited copy of a built-in skill. It no longer picks up updates — reset to go back."
                    >
                      yours · replaces built-in
                    </span>
                  )}
                  {s.manualOnly && (
                    <span
                      className="rounded bg-muted px-1 text-[10px] text-muted-foreground"
                      title="Runs only when you name it with /skill — never picked automatically"
                    >
                      manual
                    </span>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">{s.description}</p>
              </button>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {s.usage?.uses
                  ? `${s.usage.uses} use${s.usage.uses === 1 ? "" : "s"} · ${ago(s.usage.lastUsedAt)}`
                  : "never used"}
              </span>
              {s.overridesBuiltin && (
                <button
                  className={`shrink-0 text-[11px] ${
                    confirmReset === s.name
                      ? "text-destructive"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title={
                    confirmReset === s.name
                      ? "Click again to delete your copy and go back to the built-in"
                      : "Discard your copy and use the built-in version again"
                  }
                  onClick={async () => {
                    // Two clicks: this deletes the user's own edits, and the
                    // built-in behind it is the only thing that makes that
                    // recoverable — which is not the same as reversible.
                    if (confirmReset !== s.name) {
                      setConfirmReset(s.name);
                      return;
                    }
                    setConfirmReset(null);
                    try {
                      await resetSkill(s.name);
                      setRev((r) => r + 1);
                    } catch (err) {
                      setError(String(err?.message ?? err));
                    }
                  }}
                >
                  {confirmReset === s.name ? "Discard my copy?" : "Reset"}
                </button>
              )}
              <button
                className="shrink-0 text-muted-foreground hover:text-foreground"
                title="Show in Finder"
                onClick={() => window.maple?.revealFoundFile?.(s.dir)}
              >
                <FolderOpen className="size-3.5" />
              </button>
            </div>
          ),
        )}
      </div>

      {unresolved.length > 0 && (
        <p className="shrink-0 text-[11px] leading-tight text-muted-foreground">
          Asked for but not installed:{" "}
          {unresolved.slice(0, 4).map((u, i) => (
            <span key={u.name}>
              {i > 0 && ", "}
              <code className="rounded bg-muted px-1">{u.name}</code> ×{u.count}
            </span>
          ))}
          {" — a skill with one of these names would get picked up."}
        </p>
      )}
      <p className="shrink-0 text-[11px] text-muted-foreground">
        Click one to edit it here; changes apply on the next message. Skills are plain
        folders, so any editor works too. New ones: <code>enio skills --new my-skill</code>.
      </p>
    </div>
  );
}
