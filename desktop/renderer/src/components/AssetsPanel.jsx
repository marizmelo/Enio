import { useCallback, useEffect, useState } from "react";
import {
  AppWindow,
  FileText,
  Files,
  FolderOpen,
  Image as ImageIcon,
  Link2,
  Mail,
  MessageSquare,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useThumbnail } from "@/components/AttachmentChips";
import { groupByDay, listAssets, removeAsset } from "@/lib/assets";
import { cn } from "@/lib/utils";

const ICONS = { document: FileText, image: ImageIcon, app: AppWindow, email: Mail, files: Files, linked: Link2 };

const size = (bytes) =>
  bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * Everything Enio has made, in the order it was made, each row saying what
 * made it.
 *
 * A file on its own answers neither question anyone has about it: what is
 * this, and why is it here. So a row is three lines — what it is called,
 * what it is (read off the content), and why it exists: the agent and the
 * request, in the person's own words. The request is the row's link back to
 * the conversation, and it is still there to read when the conversation is
 * not: the origin is kept with the asset, not with the transcript.
 *
 * Opening does what the thing is. A document opens beside the chat, where
 * it can be read and changed; a picture opens in the viewer; an app opens
 * its page in the browser; files that live in a folder you attached open
 * in their own app, because they are yours and not Enio's copy.
 */
export function AssetsPanel({ active, project, onOpenDocument, onOpenImage, onOpenConversation }) {
  const [assets, setAssets] = useState(null);
  const [error, setError] = useState("");
  const [onlyProject, setOnlyProject] = useState(false);
  // Two clicks to remove: the first arms the row it is on.
  const [armed, setArmed] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setAssets(await listAssets());
      setError("");
    } catch (err) {
      setError(String(err?.message ?? err));
    }
  }, []);

  useEffect(() => {
    if (active) {
      setArmed(null);
      refresh();
    }
  }, [active, refresh]);

  const open = async (asset) => {
    const entry = asset.entry ?? asset.files[0]?.path;
    if (!entry) return window.maple?.revealProjectPath(asset.location);
    // Outside the workspace: a file in a folder you attached.
    if (entry.startsWith("/")) {
      const result = await window.maple?.openFoundFile?.(entry);
      if (result && !result.ok) window.maple?.revealProjectPath(entry);
      return;
    }
    if (asset.kind === "app") return window.maple?.openInDefaultApp(entry);
    if (asset.kind === "image") return onOpenImage?.(asset.files.map((f) => f.path), asset.files.findIndex((f) => f.path === entry));
    if (/\.(md|markdown|txt|html?|css|js|json|csv)$/i.test(entry)) return onOpenDocument?.(entry);
    return window.maple?.openInDefaultApp(entry);
  };

  const remove = async (asset) => {
    if (armed !== asset.id) return setArmed(asset.id);
    try {
      await removeAsset(asset.id);
      setArmed(null);
      await refresh();
    } catch (err) {
      setError(String(err?.message ?? err));
    }
  };

  const shown = (assets ?? []).filter((a) => !onlyProject || a.project?.id === project?.id);
  const groups = groupByDay(shown);

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col">
      {project && (
        <div className="mb-2 flex gap-1 text-xs">
          {[
            [false, "Everything"],
            [true, project.name],
          ].map(([value, label]) => (
            <button
              key={String(value)}
              type="button"
              onClick={() => setOnlyProject(value)}
              className={cn(
                "rounded-full border px-2.5 py-0.5",
                onlyProject === value ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="mb-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {assets === null && !error && <p className="text-xs text-muted-foreground">Reading what has been made…</p>}
        {assets !== null && groups.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Nothing yet. Documents, apps, screenshots and drafts Enio makes are listed here, newest first, with the
            request that made them.
          </p>
        )}
        {groups.map((group) => (
          <section key={group.day} className="mb-4">
            <h3 className="sticky top-0 z-10 bg-background py-1 text-xs font-medium text-muted-foreground">
              {group.label}
            </h3>
            <ul className="space-y-1">
              {group.assets.map((asset) => (
                <AssetRow
                  key={asset.id}
                  asset={asset}
                  armed={armed === asset.id}
                  onOpen={() => open(asset)}
                  onRemove={asset.legacy ? null : () => remove(asset)}
                  onOpenConversation={onOpenConversation}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function AssetRow({ asset, armed, onOpen, onRemove, onOpenConversation }) {
  const Icon = ICONS[asset.kind] ?? FileText;
  const picture = asset.kind === "image" && asset.entry && !asset.entry.startsWith("/") ? asset.entry : "";
  const thumb = useThumbnail(picture);
  const who = asset.agents.length > 0 ? asset.agents.join(", ") : null;
  const made =
    asset.source === "automation"
      ? `the ${asset.automation ?? "an"} automation`
      : asset.source === "plan"
        ? `a plan${who ? ` (${who})` : ""}`
        : who;
  const gone = asset.conversation && !asset.conversation.exists;

  return (
    <li className="flex items-start gap-2.5 rounded border p-2 text-sm">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-start gap-2.5 text-left hover:opacity-80"
        title="Open"
      >
        {thumb ? (
          <img src={thumb} alt="" className="size-9 shrink-0 rounded object-cover" />
        ) : (
          <span className="flex size-9 shrink-0 items-center justify-center rounded bg-muted">
            <Icon className="size-4 text-muted-foreground" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate font-medium">{asset.title}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {clock(asset.createdAt)}
              {asset.files.length > 1 ? ` · ${asset.files.length} files` : ""}
              {asset.bytes > 0 ? ` · ${size(asset.bytes)}` : ""}
            </span>
          </span>
          {asset.description && (
            <span className="block truncate text-xs text-muted-foreground">{asset.description}</span>
          )}
          {/* Why it exists. The request is quoted, never summarised: it is
              the one account of the asset that cannot be wrong. */}
          <span className="block truncate text-xs text-muted-foreground">
            {asset.request ? (
              <>
                {made ? `Made by ${made} for ` : "Made for "}
                <span className="text-foreground/80">“{asset.request}”</span>
              </>
            ) : asset.legacy ? (
              "From before assets were recorded; what made it is not known."
            ) : made ? (
              `Made by ${made}.`
            ) : null}
            {gone ? <span className="italic"> · conversation discarded</span> : null}
            {asset.project?.name ? ` · ${asset.project.name}` : ""}
          </span>
        </span>
      </button>
      {asset.conversation?.exists && (
        <Button
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          title={`Go to the conversation: ${asset.conversation.title}`}
          onClick={() => onOpenConversation?.(asset.conversation.id, asset.project?.id ?? null)}
        >
          <MessageSquare className="size-3.5" />
        </Button>
      )}
      <Button
        size="icon"
        variant="ghost"
        className="size-7 shrink-0"
        title="Show in Finder"
        onClick={() => window.maple?.revealProjectPath(asset.location)}
      >
        <FolderOpen className="size-3.5" />
      </Button>
      {onRemove && (
        <Button
          size={armed ? "sm" : "icon"}
          variant={armed ? "destructive" : "ghost"}
          className={cn("shrink-0", armed ? "h-7 px-2 text-xs" : "size-7")}
          title={asset.kind === "linked" ? "Remove this entry (the files stay where they are)" : "Delete this asset"}
          onClick={onRemove}
        >
          {armed ? asset.kind === "linked" ? "Remove entry" : "Delete" : <Trash2 className="size-3.5" />}
        </Button>
      )}
    </li>
  );
}
