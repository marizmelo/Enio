import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp, Loader2, Mic, Square, Volume2, VolumeX } from "lucide-react";
import { TipButton } from "@/components/TipButton";
import { Textarea } from "@/components/ui/textarea";
import { AttachMenu } from "@/components/AttachMenu";
import { ProjectFilesDialog } from "@/components/ProjectFilesDialog";
import { SlashPalette } from "@/components/SlashPalette";
import { AttachmentChips } from "@/components/AttachmentChips";
import { startRecording, transcribe } from "@/lib/dictation";
import { stopSpeaking } from "@/lib/speech";
import { MentionPalette } from "@/components/MentionPalette";
import {
  appendMention,
  applySlash,
  attachedFiles,
  completeMention,
  mentionQuery,
  removeMention,
  slashQuery,
} from "@/lib/capabilities";

/**
 * Input row. Enter sends, shift-Enter inserts a newline -- and the send button
 * stays reachable because a virtual keyboard has no reliable modifier.
 */
export const Composer = forwardRef(function Composer({
  value,
  onChange,
  onSend,
  onStop,
  disabled,
  streaming,
  capabilities = {},
  sessionFiles = [],
  conversationId = null,
  onAttached = () => {},
  conversationAttachments = [],
  placeholder = "Message Enio…",
  onAttachStanding = () => {},
  onManageConnections = () => {},
  speakReplies = false,
  onToggleSpeak = () => {},
}, handle) {
  const ref = useRef(null);

  // Grow with the content up to a ceiling, then scroll inside the box.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  // Take focus back whenever the box becomes usable again: once the backends
  // report ready, and after each answer finishes. The textarea is disabled
  // while streaming, and a disabled element cannot hold focus -- so without
  // this, every turn ends with the caret nowhere and the next message needs a
  // click first.
  useEffect(() => {
    if (!streaming && !disabled) ref.current?.focus();
  }, [streaming, disabled]);

  const [recording, setRecording] = useState(false);
  // The project file browser. A modal rather than a submenu: an attached
  // folder can hold hundreds of files, which a menu can only truncate.
  const [projectFilesOpen, setProjectFilesOpen] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorderRef = useRef(null);

  // Available while dictating too, even before any text has arrived: pressing
  // it is how you finish a sentence, so requiring text first would mean
  // stopping the recording just to enable the button that stops the recording.
  const canSend =
    !disabled && !streaming && (recording || transcribing || value.trim().length > 0);

  // Files attached during this session. capabilities.files is fetched once at
  // startup, so anything pasted or picked since then is not in it -- without
  // this, a file attached a second ago is not recognised as a file and gets no
  // chip. Still only a *known* name becomes a chip: "@researcher" is an agent
  // and "@notafile" is ordinary text the server will leave alone.
  const known = useMemo(
    () => [
      ...new Set([
        ...(capabilities.files ?? []),
        // Attachments are listed apart from workspace files so they stay out
        // of the file menu, but a mention naming one still has to become a
        // chip -- otherwise reopening a conversation shows its attachments as
        // plain text.
        ...(capabilities.attachments ?? []),
        ...sessionFiles,
      ]),
    ],
    [capabilities.files, capabilities.attachments, sessionFiles],
  );
  const attached = attachedFiles(value, known);

  // The palette is a hint list, not a focus trap: the caret stays in the
  // textarea the whole time, so cmdk never receives a keystroke and its own
  // arrow-key navigation would be dead. Enter takes the top match instead,
  // which is what the list is showing anyway.
  const slash = streaming ? null : slashQuery(value);
  const slashMatches =
    slash === null
      ? []
      : (capabilities.skills ?? []).filter((s) =>
          s.name.toLowerCase().startsWith(slash),
        );

  // Agents lead the @ palette. They are the smallest set and the one a user
  // reaches for deliberately -- files are usually picked from the menu, where
  // there is room to show a long path.
  const at = streaming ? null : mentionQuery(value);
  const mentionGroups = [];
  if (at !== null) {
    const agents = (capabilities.agents ?? [])
      .filter((a) => a.name.toLowerCase().startsWith(at))
      .map((a) => ({ token: a.name, hint: a.description }));
    const servers = (capabilities.servers ?? [])
      .filter((s) => s.toLowerCase().startsWith(at))
      .map((s) => ({ token: s, hint: "MCP connection" }));
    const files = (capabilities.files ?? [])
      .filter((f) => f.toLowerCase().startsWith(at))
      .slice(0, 8)
      .map((f) => ({ token: f, hint: null }));

    if (agents.length) mentionGroups.push({ heading: "Agents", items: agents });
    if (servers.length) mentionGroups.push({ heading: "Connections", items: servers });
    if (files.length) mentionGroups.push({ heading: "Files", items: files });
  }
  const firstMention = mentionGroups[0]?.items[0]?.token ?? null;

  const insertMention = (token) => {
    onChange(appendMention(value, token));
    ref.current?.focus();
  };

  const insertSkill = (name) => {
    onChange(applySlash(value, name));
    ref.current?.focus();
  };

  // Replaces the half-typed "@wor" rather than appending, which is what the
  // menu does — the menu has nothing half-typed to replace.
  const pickMention = (token) => {
    onChange(completeMention(value, token));
    ref.current?.focus();
  };

  // Everything below funnels into the same place: a file the agent can read is
  // a file inside the workspace, so anything from outside is copied in and then
  // referenced by name. The mention is the only thing the server ever sees.
  const attachAll = (names) => {
    let next = value;
    for (const name of names) next = appendMention(next, name);
    onAttached(names);
    onChange(next);
    ref.current?.focus();
  };

  // Recording and transcribing are separate waits: one ends when the speaker
  // says so, the other when whisper finishes. Separate state so the button can
  // say which is happening.
  // What was already in the box when dictation started. Every interim pass
  // rewrites the dictated part, so the typed part has to be held separately or
  // it gets overwritten by the first partial.
  const baseTextRef = useRef("");
  const partialBusyRef = useRef(false);

  /** Stop, transcribe once more, and return the finished text. */
  const finishDictation = async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setRecording(false);
    if (!recorder) return null;

    setTranscribing(true);
    try {
      const text = (await transcribe(await recorder.stop())).trim();
      const base = baseTextRef.current;
      return text ? (base ? `${base.replace(/\s+$/, "")} ${text}` : text) : base;
    } catch (err) {
      console.error("dictation failed:", err);
      return baseTextRef.current || null;
    } finally {
      setTranscribing(false);
    }
  };

  // Interim passes while recording. Whisper is not a streaming recogniser, so
  // each pass re-transcribes everything said so far -- which is why the text
  // can revise itself mid-sentence rather than only extending. Skipped while a
  // pass is already in flight, because they take longer than the interval as
  // the clip grows and would otherwise queue up behind each other.
  useEffect(() => {
    if (!recording) return undefined;

    const id = setInterval(async () => {
      const recorder = recorderRef.current;
      if (!recorder || partialBusyRef.current) return;

      partialBusyRef.current = true;
      try {
        const text = (await transcribe(recorder.snapshot(), { fast: true })).trim();
        // Checked again after the await: the recording may have been stopped
        // while this was in flight, and overwriting the final text with a
        // stale partial would undo it.
        if (text && recorderRef.current) {
          const base = baseTextRef.current;
          onChange(base ? `${base.replace(/\s+$/, "")} ${text}` : text);
        }
      } catch {
        // A failed partial is not worth surfacing; the final pass still runs.
      } finally {
        partialBusyRef.current = false;
      }
    }, 900);

    return () => clearInterval(id);
  }, [recording, onChange]);

  const toggleDictation = async () => {
    if (recording) {
      const text = await finishDictation();
      if (text !== null) onChange(text);
      ref.current?.focus();
      return;
    }

    try {
      // Talking over the answer is the one thing pressing the microphone
      // clearly does not mean. Cut it off before the mic opens, so the reply
      // being read aloud does not end up in the recording either.
      stopSpeaking();
      baseTextRef.current = value;
      recorderRef.current = await startRecording();
      setRecording(true);
    } catch (err) {
      // Denied, or no microphone. The OS prompt has already said everything
      // there is to say.
      console.error("microphone unavailable:", err);
    }
  };

  /**
   * Send, finishing dictation first if it is running.
   *
   * So the send button works mid-sentence: stop talking and press it, or press
   * it while still talking, and the last words still make it into the message
   * rather than being cut off at whatever the most recent partial happened to
   * catch.
   */
  const submit = async () => {
    if (recording || transcribing) {
      const text = await finishDictation();
      if (text?.trim()) {
        onChange(text);
        onSend(text);
      }
      return;
    }
    onSend();
  };

  useImperativeHandle(handle, () => ({
    startDictation: () => {
      if (!recording && !transcribing) toggleDictation();
    },
    // The launcher prefills and hands the caret over; typing continues the
    // template rather than starting over.
    focus: () => ref.current?.focus(),
  }));

  const pickFiles = async () => {
    // The project's attached roots go with the request so a file already
    // inside one comes back as its alias path rather than a copy.
    const roots = capabilities.project?.attachments ?? [];
    const names = (await window.maple?.pickFiles(conversationId, roots)) ?? [];
    if (names.length > 0) attachAll(names);
  };

  /** Image bytes with no path: a paste, or a drag from a browser. */
  const saveImageBlob = async (file) => {
    const buffer = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    // Chunked because String.fromCharCode(...bytes) blows the argument limit on
    // anything larger than a small icon.
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return window.maple?.saveImage(file.name || "pasted.png", btoa(binary), conversationId);
  };

  const handlePaste = async (e) => {
    const images = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    e.preventDefault();
    const names = (await Promise.all(images.map(saveImageBlob))).filter(Boolean);
    if (names.length > 0) attachAll(names);
  };

  const handleDrop = async (e) => {
    const dropped = [...e.dataTransfer.files];
    if (dropped.length === 0) return;
    e.preventDefault();
    // A dragged file has a real path; only pasted bytes need the base64 route.
    const paths = dropped.map((f) => window.maple?.filePath?.(f) ?? null);
    const names = [];
    for (let i = 0; i < dropped.length; i++) {
      names.push(
        paths[i]
          ? await window.maple?.importFile(paths[i], conversationId)
          : await saveImageBlob(dropped[i]),
      );
    }
    const usable = names.filter(Boolean);
    if (usable.length > 0) attachAll(usable);
  };

  return (
    <footer className="relative flex shrink-0 items-end gap-2 border-t p-3">
      {attached.length > 0 && slashMatches.length === 0 && mentionGroups.length === 0 && (
        <AttachmentChips
          names={attached}
          onRemove={(name) => {
            onChange(removeMention(value, name));
            ref.current?.focus();
          }}
        />
      )}

      {slashMatches.length > 0 && (
        <SlashPalette matches={slashMatches} onPick={insertSkill} />
      )}

      {slashMatches.length === 0 && mentionGroups.length > 0 && (
        <MentionPalette groups={mentionGroups} onPick={pickMention} />
      )}

      <ProjectFilesDialog
        open={projectFilesOpen}
        onOpenChange={setProjectFilesOpen}
        project={capabilities.project}
        files={capabilities.files ?? []}
        onPick={(path) => attachAll([path])}
      />

      <AttachMenu
        capabilities={capabilities}
        onInsertMention={insertMention}
        onInsertSkill={insertSkill}
        conversationAttachments={conversationAttachments}
          onAttachStanding={onAttachStanding}
          onManageConnections={onManageConnections}
          onPickFiles={pickFiles}
        onBrowseProject={() => setProjectFilesOpen(true)}
        disabled={disabled || streaming}
      />

      <Textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={streaming}
        placeholder={placeholder}
        className="max-h-[200px] min-h-[40px] resize-none"
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // While the palette is open the arrow keys and Enter belong to it,
          // not to the box -- otherwise Enter sends "/comm" as a message
          // instead of picking the skill it is clearly the prefix of.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (slashMatches.length > 0) {
              insertSkill(slashMatches[0].name);
              return;
            }
            if (firstMention) {
              pickMention(firstMention);
              return;
            }
            if (canSend) submit();
          }
        }}
      />

      <TipButton
        tip={speakReplies ? "Stop reading replies aloud" : "Read replies aloud"}
        onClick={onToggleSpeak}
        className={speakReplies ? "text-foreground" : "text-muted-foreground"}
      >
        {speakReplies ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
      </TipButton>

      {capabilities.voice?.transcription && !streaming && (
        <TipButton
          tip={recording ? "Stop and transcribe" : "Dictate"}
          variant={recording ? "destructive" : "ghost"}
          onClick={toggleDictation}
          disabled={disabled || transcribing}
        >
          {transcribing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Mic className="size-4" />
          )}
        </TipButton>
      )}

      {streaming ? (
        <TipButton tip="Stop generating" variant="secondary" onClick={onStop}>
          <Square className="size-4" />
        </TipButton>
      ) : (
        <TipButton tip="Send" variant="default" onClick={submit} disabled={!canSend}>
          <ArrowUp className="size-4" />
        </TipButton>
      )}
    </footer>
  );
});
