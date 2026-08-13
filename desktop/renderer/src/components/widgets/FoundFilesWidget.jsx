import { useState } from "react";
import { ExternalLink, FileText, FolderOpen } from "lucide-react";
import { TipButton } from "@/components/TipButton";

/**
 * The files find_file located, each one click from being looked at.
 *
 * These paths are usually OUTSIDE the workspace, so none of the usual
 * affordances (canvas, viewer, attach) can reach them — Open and Show in
 * Finder go through their own guarded IPC instead. Buttons the user
 * clicks, never actions the model takes: the tool's text already told the
 * model everything it gets to know.
 */
export function FoundFilesWidget({ paths }) {
  const [note, setNote] = useState("");
  if (!paths?.length) return null;

  const open = async (p) => {
    const result = await window.maple?.openFoundFile?.(p);
    if (result && !result.ok) {
      setNote(result.reason ?? "Could not open it.");
      setTimeout(() => setNote(""), 4000);
    }
  };

  return (
    <div className="max-w-[85%] rounded-md border">
      <ul className="max-h-56 overflow-y-auto">
        {paths.map((p) => {
          const parts = p.split("/");
          const base = parts.pop();
          return (
            <li
              key={p}
              className="group flex items-center gap-2 border-b px-2.5 py-1.5 text-xs last:border-b-0"
            >
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate" title={p}>
                <span className="font-medium">{base}</span>
                <span className="ml-1.5 text-[10px] text-muted-foreground">
                  {parts.join("/").replace(/^\/Users\/[^/]+/, "~")}
                </span>
              </span>
              <TipButton
                tip="Open in its app"
                className="size-6 shrink-0 opacity-0 group-hover:opacity-100"
                onClick={() => open(p)}
              >
                <ExternalLink className="size-3" />
              </TipButton>
              <TipButton
                tip="Show in Finder"
                className="size-6 shrink-0 opacity-0 group-hover:opacity-100"
                onClick={() => window.maple?.revealFoundFile?.(p)}
              >
                <FolderOpen className="size-3" />
              </TipButton>
            </li>
          );
        })}
      </ul>
      {note && <p className="border-t px-2.5 py-1 text-[11px] text-destructive">{note}</p>}
    </div>
  );
}
