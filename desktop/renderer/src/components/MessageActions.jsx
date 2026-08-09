import { useState } from "react";
import { Check, Copy, Square, Volume2 } from "lucide-react";
import { TipButton } from "@/components/TipButton";
import { speakAll, stopSpeaking } from "@/lib/speech";

/**
 * What to do with an answer once it has arrived.
 *
 * Under the message rather than beside it: these act on a finished reply, and
 * putting them inline would put them in the way of reading it.
 */
export function MessageActions({ content, canSpeak = true }) {
  const [copied, setCopied] = useState(false);
  const [playing, setPlaying] = useState(false);

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
      <TipButton tip={copied ? "Copied" : "Copy"} className="size-7" onClick={copy}>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </TipButton>
      {/* A speaker, not a microphone. Under an answer the obvious question is
          "read this to me", and a mic here read as "talk to it" -- which is
          what the composer's button is already for. */}
      {canSpeak && (
      <TipButton
        tip={playing ? "Stop" : "Read aloud"}
        className="size-7"
        onClick={async () => {
          if (playing) {
            stopSpeaking();
            setPlaying(false);
            return;
          }
          setPlaying(true);
          try {
            await speakAll(content);
          } finally {
            // In a finally because speak() can resolve early -- if a drain is
            // already running the new text is queued and returns at once, and
            // without this the button would sit on "Stop" forever with nothing
            // left to stop.
            setPlaying(false);
          }
        }}
      >
        {playing ? <Square className="size-3.5" /> : <Volume2 className="size-3.5" />}
      </TipButton>
      )}
    </div>
  );
}
