import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AccountsPanel } from "@/components/AccountsPanel";
import { getApps, invalidateApps, setEditor } from "@/lib/apps";

/**
 * Enio's own setup, as distinct from what the user connects for themselves.
 *
 * Accounts carry an owner, and the owner used to be a switch in the connect
 * form that asked "whose account is this?" every time. Answered wrong once,
 * it sends mail under the wrong name, so the question became a door: an
 * account connected here is Enio's own; one connected under Connections is
 * the user's. The flag and the resolver are unchanged — a row can still be
 * moved to the other side — only the asking moved.
 */
export function SettingsDialog({ open, onOpenChange, initialView = "list" }) {
  const [error, setError] = useState("");
  const [view, setView] = useState("list");
  // Which code editor Enio hands code to. Detected from what is installed;
  // one found is used as is, several is a choice made here or at the first
  // "Edit in…", none says what Enio looked for.
  const [apps, setApps] = useState(null);

  useEffect(() => {
    if (open) {
      setError("");
      setView(initialView);
      invalidateApps();
      getApps().then(setApps);
    }
  }, [open, initialView]);

  const chooseEditor = async (id) => {
    try {
      setApps(await setEditor(id || null));
    } catch (err) {
      setError(String(err?.message ?? err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-3 sm:max-w-lg">
        <DialogHeader className="shrink-0">
          {view === "add-account" ? (
            <>
              <button
                type="button"
                onClick={() => setView("list")}
                className="mb-1 inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" /> Settings
              </button>
              <DialogTitle>Connect Enio's own account</DialogTitle>
              <DialogDescription>
                Its identity: the address it sends from, the calendar it can be invited to. Your own
                accounts connect under Connections.
              </DialogDescription>
            </>
          ) : (
            <>
              <DialogTitle>Settings</DialogTitle>
              <DialogDescription>
                Enio's own setup. What you let it reach — your accounts, MCP servers — lives under
                Connections.
              </DialogDescription>
            </>
          )}
        </DialogHeader>

        {error && <p className="shrink-0 text-xs text-destructive">{error}</p>}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          {view !== "add-account" && (
            <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Enio's account
            </h3>
          )}
          <AccountsPanel
            owner="agent"
            view={view === "add-account" ? "add" : "list"}
            onView={(v) => setView(v === "add" ? "add-account" : "list")}
            onError={setError}
          />

          {view !== "add-account" && apps && (
            <section className="space-y-2">
              <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Your apps
              </h3>
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-3">
                  <label className="text-sm font-medium" htmlFor="code-editor">
                    Code editor
                  </label>
                  <select
                    id="code-editor"
                    className="h-7 rounded-md border bg-background px-2 text-xs"
                    value={apps.choice === "set" ? apps.editor?.id ?? "" : ""}
                    onChange={(e) => chooseEditor(e.target.value)}
                  >
                    <option value="">
                      {apps.choice === "detected" && apps.editor
                        ? `${apps.editor.name} (the one found)`
                        : apps.choice === "ambiguous"
                          ? "Not chosen yet"
                          : "None"}
                    </option>
                    {apps.editors
                      .filter((e) => e.installed)
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                  </select>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {apps.editors.some((e) => e.installed)
                    ? `Enio hands code to this editor: Edit in it from a file, Open in it from a project folder, or say "open the project in ${apps.editor?.name ?? "my editor"}". Found: ${apps.editors.filter((e) => e.installed).map((e) => e.name).join(", ")}.`
                    : "No code editor was found. Enio looks for Cursor, Visual Studio Code, VSCodium, Zed, Sublime Text, Nova and BBEdit; files still open with the system's default app."}
                </p>
              </div>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
