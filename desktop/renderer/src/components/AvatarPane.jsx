import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Loader2, Maximize2, Minimize2, ScanFace, X } from "lucide-react";
import { TipButton } from "@/components/TipButton";
import { cn } from "@/lib/utils";
import { clearSpeechSink, onSpeaking, setSpeechSink } from "@/lib/speech";
import { createAvatarSink } from "@/lib/avatar-sink";
import { createTalkingHead, disposeTalkingHead } from "@/lib/avatar-head";
import { loadAvatarModel } from "@/lib/avatar-assets";

/**
 * Enio's face.
 *
 * A view, not a source of truth: the director in App decides what the face
 * does from the events the window already receives, and this component
 * carries the commands out on a TalkingHead instance held in a ref. It is
 * mounted outside the message list on purpose -- every bubble re-renders
 * per token, and a WebGL scene must not.
 *
 * While mounted, spoken sentences are routed through the head (see
 * speech.js), so the mouth and the sound share one clock. On unmount the
 * player falls back to its element; a sentence in flight is cut, the rest
 * of the reply is still said.
 *
 * Degrades to nothing: a model that fails to load, a GPU that refuses, a
 * route that 404s -- the words still arrive as text and audio, and a broken
 * face is worse than no face.
 */
const VIEW = { pip: "head", panel: "upper" };

function gaze(head, target) {
  // eyesRotateX is the library's composite over eyesLookUp/eyesLookDown. A
  // fixed value wins over its own animations, which is why looking at the
  // camera or ahead must release it first.
  if (target === "up") head.setFixedValue("eyesRotateX", -0.35);
  else if (target === "down") head.setFixedValue("eyesRotateX", 0.4);
  else {
    head.setFixedValue("eyesRotateX", null);
    if (target === "camera") head.lookAtCamera(1000);
    else head.lookAhead(1000);
  }
}

export const AvatarPane = forwardRef(function AvatarPane(
  { mode = "pip", capability, director, speakReplies, onExpand, onCollapse, onClose, onInstall, className },
  ref,
) {
  const nodeRef = useRef(null);
  const headRef = useRef(null);
  const sinkRef = useRef(null);
  const installed = Boolean(capability?.installed);
  const body = capability?.body ?? "M";
  const [phase, setPhase] = useState(installed ? "loading" : "setup");
  const [setup, setSetup] = useState(null); // null | "installing" | "failed"

  const apply = (cmd) => {
    const head = headRef.current;
    if (!head || !head.armature) return;
    try {
      if (cmd.cmd === "mood") head.setMood(cmd.mood);
      else if (cmd.cmd === "gesture") head.playGesture(cmd.name, 2);
      else if (cmd.cmd === "gaze") gaze(head, cmd.target);
      else if (cmd.cmd === "listening") {
        head.setValue("browInnerUp", cmd.on ? 0.25 : 0, 400);
        if (cmd.on) head.lookAtCamera(800);
      }
    } catch {
      // A face that cannot do one thing keeps doing the rest.
    }
  };
  useImperativeHandle(ref, () => ({ apply }));

  useEffect(() => {
    if (!installed || !nodeRef.current) return undefined;
    let cancelled = false;
    setPhase("loading");
    const head = createTalkingHead(nodeRef.current, { view: VIEW[mode] ?? "head", rotate: mode === "panel" });
    headRef.current = head;
    (async () => {
      try {
        const { url } = await loadAvatarModel();
        // avatarIgnoreCamera: the library's "look at the camera" folds the
        // camera's own rotation and the pose chain into a head turn, which in
        // a small embedded canvas left the face yawed to one side. Looking
        // straight out of the canvas is looking at the person.
        await head.showAvatar({ url, body, avatarMood: "neutral", lipsyncLang: "en", avatarIgnoreCamera: true });
        if (cancelled) return;
        head.start();
        const sink = createAvatarSink(head);
        sinkRef.current = sink;
        setSpeechSink(sink);
        for (const cmd of director?.snapshot?.() ?? []) apply(cmd);
        // Being shown is activity: without this a face asked for after
        // hours away would doze off on its first idle tick.
        for (const cmd of director?.handle?.({ type: "shown" }, Date.now()) ?? []) apply(cmd);
        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        console.error("[avatar]", err);
        setPhase("error");
      }
    })();
    // The render loop stops with the window hidden; speech keeps playing,
    // since the library paces it off audio events, not frames.
    const onVisibility = () => {
      if (document.visibilityState === "hidden") head.stop();
      else head.start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // Only a visible face needs to doze off.
    const clock = setInterval(() => {
      for (const cmd of director?.tick?.(Date.now()) ?? []) apply(cmd);
    }, 15_000);
    // The person being here is activity: a pointer moving over the window,
    // a key, the window taking focus, the voice speaking. Without these the
    // idle clock counted only turns, and the face fell asleep in front of
    // someone who was reading its last answer. Pointer moves are frequent,
    // so they report at most once a second.
    let lastPresence = 0;
    const presence = () => {
      const now = Date.now();
      if (now - lastPresence < 1000) return;
      lastPresence = now;
      for (const cmd of director?.handle?.({ type: "activity" }, now) ?? []) apply(cmd);
    };
    window.addEventListener("pointermove", presence);
    window.addEventListener("pointerdown", presence);
    window.addEventListener("keydown", presence);
    window.addEventListener("focus", presence);
    const offSpeaking = onSpeaking((on) => {
      if (on) presence();
    });
    return () => {
      cancelled = true;
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", presence);
      window.removeEventListener("pointerdown", presence);
      window.removeEventListener("keydown", presence);
      window.removeEventListener("focus", presence);
      offSpeaking();
      if (sinkRef.current) {
        clearSpeechSink(sinkRef.current);
        sinkRef.current.dispose();
        sinkRef.current = null;
      }
      disposeTalkingHead(head);
      headRef.current = null;
    };
    // apply reads refs only, and director is a stable ref-held object, so
    // neither is a dependency.
  }, [installed, body, mode]);

  if (phase === "error") return null;

  return (
    <div className={cn("group relative overflow-hidden rounded-lg border bg-background shadow-sm", className)}>
      <div ref={nodeRef} className={cn("h-full w-full", phase !== "ready" && "invisible")} />
      {phase === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      )}
      {phase === "setup" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center text-xs text-muted-foreground">
          <ScanFace className="size-6" />
          <p>Enio has no face yet.</p>
          {onInstall && (
            <button
              className={cn("rounded border px-2 py-1 hover:bg-muted", setup === "failed" && "text-destructive")}
              disabled={setup === "installing"}
              title="Downloads the default head once; or bring your own: enio avatar use <file.glb>"
              onClick={async () => {
                if (setup === "installing") return;
                setSetup("installing");
                const ok = await onInstall();
                setSetup(ok ? null : "failed");
              }}
            >
              {setup === "installing" ? "Setting up…" : setup === "failed" ? "Setup failed — see the dialog" : "Set up the default head"}
            </button>
          )}
          <p className="text-[10px]">or: enio avatar use &lt;file.glb&gt;</p>
        </div>
      )}
      <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {mode === "pip" && onExpand && (
          <TipButton tip="Expand" className="size-6" onClick={onExpand}>
            <Maximize2 className="size-3" />
          </TipButton>
        )}
        {mode === "panel" && onCollapse && (
          <TipButton tip="Shrink" className="size-6" onClick={onCollapse}>
            <Minimize2 className="size-3" />
          </TipButton>
        )}
        {onClose && (
          <TipButton tip="Hide" className="size-6" onClick={onClose}>
            <X className="size-3" />
          </TipButton>
        )}
      </div>
      {phase === "ready" && !speakReplies && (
        <p className="pointer-events-none absolute inset-x-0 bottom-1 text-center text-[10px] text-muted-foreground">
          Turn on Read replies aloud to hear it
        </p>
      )}
    </div>
  );
});
