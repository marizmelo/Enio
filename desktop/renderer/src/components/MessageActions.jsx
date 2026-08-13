import { useState } from "react";
import { ArrowUpRight, Check, Copy, Cpu, Globe, Square, Volume2 } from "lucide-react";
import { TipButton } from "@/components/TipButton";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { speakAll, stopSpeaking } from "@/lib/speech";

/**
 * What to do with an answer once it has arrived.
 *
 * Under the message rather than beside it: these act on a finished reply, and
 * putting them inline would put them in the way of reading it.
 */
export function MessageActions({ content, canSpeak = true, onAskBigger, upgrade, onTryUpgrade }) {
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
      {/* The escape hatch for a disappointing answer. On every reply, not
          just failures, because "not what I wanted" is the user's judgement
          -- the one call the local model must never make about itself.

          Two escalations exist and they differ in the fact that matters
          most, privacy direction -- so when this machine can genuinely run
          something bigger (the server computed that, not a guess) the arrow
          opens a choice. When it cannot, the item is withheld rather than
          greyed and the arrow goes straight to the cloud handoff. */}
      {onAskBigger && !(upgrade && onTryUpgrade) && (
        <TipButton
          tip="Ask a bigger model — package this for a cloud AI"
          className="size-7"
          onClick={onAskBigger}
        >
          <ArrowUpRight className="size-3.5" />
        </TipButton>
      )}
      {onAskBigger && upgrade && onTryUpgrade && (
        <DropdownMenu>
          {/* A plain Button, not TipButton: the tooltip's root would swallow
              the slotted trigger props and the menu would never open. */}
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="size-7" title="Ask a bigger model">
              <ArrowUpRight className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={onAskBigger}>
              <Globe className="size-3.5" />
              <span className="flex flex-col">
                <span>Package for a cloud AI</span>
                <span className="text-[11px] text-muted-foreground">
                  most capable — nothing leaves until you paste it
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onTryUpgrade}>
              <Cpu className="size-3.5" />
              <span className="flex flex-col">
                <span>Try {upgrade.label} locally</span>
                <span className="text-[11px] text-muted-foreground">
                  {upgrade.tokensPerSecond
                    ? `~${upgrade.tokensPerSecond} tok/s on this machine — stays private`
                    : "stays private"}
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
