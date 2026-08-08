import { useEffect, useRef } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * Input row. Enter sends, shift-Enter inserts a newline -- and the send button
 * stays reachable because a virtual keyboard has no reliable modifier.
 */
export function Composer({ value, onChange, onSend, onStop, disabled, streaming }) {
  const ref = useRef(null);

  // Grow with the content up to a ceiling, then scroll inside the box.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = !disabled && !streaming && value.trim().length > 0;

  return (
    <footer className="flex shrink-0 items-end gap-2 border-t p-3">
      <Textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={streaming}
        placeholder="Message Enio…"
        className="max-h-[200px] min-h-[40px] resize-none"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (canSend) onSend();
          }
        }}
      />
      {streaming ? (
        <Button size="icon" variant="secondary" onClick={onStop} title="Stop">
          <Square className="size-4" />
        </Button>
      ) : (
        <Button size="icon" onClick={onSend} disabled={!canSend} title="Send">
          <ArrowUp className="size-4" />
        </Button>
      )}
    </footer>
  );
}
