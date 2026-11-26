import { useEffect, useRef } from "react";
import { AudioLines, Loader2, Mic, MicOff, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { meterHeight, onVoiceLevel } from "@/lib/voice-meter";

/**
 * Talking to the face, from the face.
 *
 * This control used to sit in the message box between the speaker and the
 * dictation mic: three small icons in a row, two of which open the
 * microphone and mean different things. Dictating a prompt and holding a
 * conversation are not the same act — one fills the box for you to send,
 * the other is hands-off — and the conversation is with the face, so its
 * control lives on the face.
 *
 * Two buttons where the old one had a single button with two meanings: the
 * state pill interrupts (cuts speech, aborts the turn, goes back to
 * listening), and End leaves the mode. One control that exits or interrupts
 * depending on what it happens to say was learnable; it was not obvious.
 *
 * While listening, the pill shows the room's level. A mode that says
 * "listening…" and gives no sign of hearing is indistinguishable from one
 * that hears nothing — which is exactly what an open-but-silent microphone
 * looks like, and that case gets its own sentence.
 */
export function AvatarTalk({ voice, compact = false }) {
  const bars = useRef([]);
  const listening = voice?.state === "listening";

  useEffect(() => {
    if (!listening) return undefined;
    // Three bars off one level, each a little behind the last, so it reads
    // as a voice and not as a progress bar.
    const recent = [0, 0, 0];
    return onVoiceLevel((rms) => {
      recent.unshift(meterHeight(rms));
      recent.length = 3;
      recent.forEach((h, i) => {
        const el = bars.current[i];
        if (el) el.style.transform = `scaleY(${Math.max(0.12, h)})`;
      });
    });
  }, [listening]);

  if (!voice) return null;
  if (!voice.available) {
    return (
      <p className="pointer-events-none absolute inset-x-0 bottom-1 px-2 text-center text-[10px] text-muted-foreground">
        Set up voice from the mic in the message box to talk
      </p>
    );
  }

  const { state } = voice;
  const base =
    "pointer-events-auto flex items-center gap-1.5 rounded-full border bg-background/90 shadow-sm backdrop-blur transition-colors";

  if (!state) {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
        <button
          type="button"
          onClick={voice.onToggle}
          title="Talk with Enio: speak, and it answers aloud"
          className={cn(base, "hover:bg-muted", compact ? "h-7 px-2.5 text-[11px]" : "h-9 px-4 text-sm")}
        >
          <Mic className={compact ? "size-3" : "size-4"} />
          Talk
        </button>
      </div>
    );
  }

  const busy = state === "thinking" || state === "speaking" || state === "transcribing";
  const label =
    state === "listening"
      ? voice.dead
        ? "no sound"
        : "listening"
      : state === "held"
        ? "paused"
        : state;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-2 flex flex-col items-center gap-1 px-2">
      {voice.dead && state === "listening" && !compact && (
        <p className="pointer-events-auto rounded bg-background/90 px-2 py-1 text-center text-[11px] leading-snug text-destructive shadow-sm">
          The microphone is open but no sound is reaching Enio. Check the input device and its mute switch, and
          Microphone access for Enio in System Settings.
        </p>
      )}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={busy ? voice.onInterrupt : undefined}
          disabled={!busy}
          title={
            busy
              ? "Interrupt: stop this and listen again"
              : voice.dead
                ? "The microphone is open but silent"
                : "Listening: just speak"
          }
          className={cn(
            base,
            compact ? "h-7 px-2.5 text-[11px]" : "h-9 px-4 text-sm",
            state === "listening" && !voice.dead && "border-primary/50 text-primary",
            state === "listening" && voice.dead && "border-destructive/50 text-destructive",
            busy && "hover:bg-muted",
          )}
        >
          {state === "listening" && !voice.dead && (
            <span className="flex h-3.5 items-center gap-[2px]" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  ref={(el) => (bars.current[i] = el)}
                  className="h-full w-[3px] origin-center rounded-full bg-primary transition-transform duration-75"
                  style={{ transform: "scaleY(0.12)" }}
                />
              ))}
            </span>
          )}
          {state === "listening" && voice.dead && <MicOff className={compact ? "size-3" : "size-4"} />}
          {(state === "thinking" || state === "transcribing") && (
            <Loader2 className={cn("animate-spin", compact ? "size-3" : "size-4")} />
          )}
          {state === "speaking" && <AudioLines className={cn("animate-pulse", compact ? "size-3" : "size-4")} />}
          {state === "held" && <Mic className={cn("opacity-50", compact ? "size-3" : "size-4")} />}
          {label}
        </button>
        <button
          type="button"
          onClick={voice.onToggle}
          title="End the conversation"
          className={cn(base, "justify-center hover:bg-muted", compact ? "size-7" : "size-9")}
        >
          <X className={compact ? "size-3" : "size-4"} />
        </button>
      </div>
    </div>
  );
}
