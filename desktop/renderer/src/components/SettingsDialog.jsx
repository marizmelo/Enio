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

  useEffect(() => {
    if (open) {
      setError("");
      setView(initialView);
    }
  }, [open, initialView]);

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
        </div>
      </DialogContent>
    </Dialog>
  );
}
