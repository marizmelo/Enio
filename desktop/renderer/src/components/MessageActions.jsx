import { useState } from "react";
import { Check, Copy, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * What to do with an answer once it has arrived.
 *
 * Under the message rather than beside it: these act on a finished reply, and
 * putting them inline would put them in the way of reading it.
 */
export function MessageActions({ content, onDictate }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      // Through the main process: the renderer's clipboard API is gated behind
      // a permission it does not have and fails with NotAllowedError.
      await window.maple?.copyText(content);
      setCopied(true);
      // Reverts on its own: a tick that stays forever stops meaning "just now".
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard refused. Nothing useful to say about it. */
    }
  };

  return (
    <div className="flex items-center gap-1 opacity-60 transition-opacity hover:opacity-100">
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        title={copied ? "Copied" : "Copy"}
        onClick={copy}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        title="Reply by voice"
        onClick={onDictate}
      >
        <Mic className="size-3.5" />
      </Button>
    </div>
  );
}
