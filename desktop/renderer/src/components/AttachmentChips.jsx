import { useEffect, useState } from "react";
import { FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isImageName } from "@/lib/capabilities";

/**
 * A thumbnail for a workspace image, or null while it loads or if it cannot be
 * previewed. Reads through the preload bridge because the renderer is
 * sandboxed and has no filesystem of its own.
 */
export function useThumbnail(name) {
  const [src, setSrc] = useState(null);

  useEffect(() => {
    if (!isImageName(name)) {
      setSrc(null);
      return;
    }
    let live = true;
    window.maple?.readAttachment(name).then((url) => {
      if (live) setSrc(url ?? null);
    });
    // Nulled on unmount so a slow read cannot paint a thumbnail onto whatever
    // replaced this chip.
    return () => {
      live = false;
    };
  }, [name]);

  return src;
}

function Chip({ name, onRemove }) {
  const src = useThumbnail(name);

  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 py-1 pl-1 pr-1">
      {src ? (
        <img src={src} alt={name} className="size-8 shrink-0 rounded object-cover" />
      ) : (
        <div className="flex size-8 shrink-0 items-center justify-center rounded bg-muted">
          <FileText className="size-4 text-muted-foreground" />
        </div>
      )}
      <span className="max-w-[160px] truncate font-mono text-xs">{name}</span>
      <Button
        size="icon"
        variant="ghost"
        className="size-6 shrink-0"
        title={`Remove ${name}`}
        onClick={() => onRemove(name)}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

/**
 * What is attached to the message being written, and a way to take it back off.
 *
 * The names stay in the text as @mentions — that is what the server reads, and
 * it is also how you refer to one attachment among several ("compare @a.png
 * with @b.png"). These chips are a view of that, not a second copy of it.
 */
export function AttachmentChips({ names, onRemove }) {
  if (names.length === 0) return null;

  return (
    <div className="absolute bottom-full left-3 right-3 mb-2 flex flex-wrap gap-2">
      {names.map((name) => (
        <Chip key={name} name={name} onRemove={onRemove} />
      ))}
    </div>
  );
}
