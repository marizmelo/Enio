import { FileText } from "lucide-react";
import { useThumbnail } from "@/components/AttachmentChips";

function Preview({ name }) {
  const src = useThumbnail(name);

  if (!src) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="max-w-[200px] truncate font-mono text-xs">{name}</span>
      </div>
    );
  }

  return (
    <figure className="overflow-hidden rounded-md border">
      <img src={src} alt={name} className="max-h-48 max-w-full object-contain" />
      <figcaption className="truncate border-t bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
        {name}
      </figcaption>
    </figure>
  );
}

/**
 * What was attached to a message, shown in the thread.
 *
 * Worth the space: the model answers from OCR text, so without the picture
 * there is no way to tell a wrong answer from a bad scan — and the difference
 * matters, because one is the model's fault and the other is yours to fix by
 * attaching something clearer.
 */
export function AttachmentPreviews({ names }) {
  if (names.length === 0) return null;

  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
      {names.map((name) => (
        <Preview key={name} name={name} />
      ))}
    </div>
  );
}
