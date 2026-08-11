import { FileText } from "lucide-react";
import { useThumbnail } from "@/components/AttachmentChips";

function Preview({ name, onOpen }) {
  const src = useThumbnail(name);
  const label = name.split("/").pop();

  if (!src) {
    return (
      <button
        type="button"
        onClick={onOpen}
        title={`Open ${label}`}
        className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5 hover:bg-muted"
      >
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="max-w-[200px] truncate font-mono text-xs">{label}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Open ${label}`}
      className="overflow-hidden rounded-md border hover:opacity-90"
    >
      <img src={src} alt={label} className="max-h-48 max-w-full object-contain" />
      <span className="block truncate border-t bg-muted/40 px-2 py-1 text-left font-mono text-[11px] text-muted-foreground">
        {label}
      </span>
    </button>
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
export function AttachmentPreviews({ names, onOpen }) {
  if (names.length === 0) return null;

  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
      {names.map((name, i) => (
        <Preview key={name} name={name} onOpen={() => onOpen?.(names, i)} />
      ))}
    </div>
  );
}
