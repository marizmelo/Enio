import { useEffect, useState } from "react";
import { AlertTriangle, BookOpen, FolderOpen } from "lucide-react";
import { listSkills } from "@/lib/skills";

/**
 * The Skills tab: the know-how Enio has, made visible. Read-only on
 * purpose — a skill is a folder of markdown the user owns, so the panel
 * shows what is installed, whether it gets used, and where it lives, and
 * editing stays in the user's editor via Reveal.
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

export function SkillsPanel({ open }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    listSkills()
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((err) => setError(String(err?.message ?? err)));
  }, [open]);

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
              <div className="min-w-0 flex-1">
                <span className="text-sm">{s.name}</span>
                <p className="text-xs opacity-80">{s.reason}</p>
              </div>
              <button
                className="shrink-0 text-muted-foreground hover:text-foreground"
                title="Show in Finder"
                onClick={() => window.maple?.revealFoundFile?.(s.dir)}
              >
                <FolderOpen className="size-3.5" />
              </button>
            </div>
          ) : (
            <div key={s.dir} className="flex items-start gap-2 border-b px-3 py-2 last:border-b-0">
              <BookOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm">{s.name}</span>
                  {s.source === "project" && (
                    <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                      project
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
              </div>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {s.usage?.uses
                  ? `${s.usage.uses} use${s.usage.uses === 1 ? "" : "s"} · ${ago(s.usage.lastUsedAt)}`
                  : "never used"}
              </span>
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
        Skills are folders of markdown — edit them in any editor; changes apply on the next
        message. New ones: <code>enio skills --new my-skill</code>.
      </p>
    </div>
  );
}
