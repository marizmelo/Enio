import { FileImage } from "lucide-react";
import { useThumbnail } from "@/components/AttachmentChips";

/**
 * A picture the user should verify with their own eyes — screenshots, mainly.
 *
 * The bubble above holds the vision model's *reading* of the image, and that
 * reading is sometimes wrong; the pixels are the check. The thumbnail comes
 * through the same 4MB-capped bridge the chips use, and a Retina full-screen
 * PNG routinely exceeds it — that case degrades to a named chip that still
 * opens the full viewer, never to a blank.
 */
export function ImageWidget({ path, caption, onOpenFile }) {
  const src = useThumbnail(path);

  if (!src) {
    return (
      <button
        className="mt-1 inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs hover:bg-muted"
        onClick={() => onOpenFile?.([path], 0)}
      >
        <FileImage className="size-3.5" />
        <span className="font-mono">{path}</span>
      </button>
    );
  }

  return (
    <button
      className="mt-1 block overflow-hidden rounded-lg border text-left"
      title={caption ? `${caption} — click to open` : "Click to open"}
      onClick={() => onOpenFile?.([path], 0)}
    >
      <img src={src} alt={caption ?? path} className="max-h-64 max-w-full object-contain" />
    </button>
  );
}
