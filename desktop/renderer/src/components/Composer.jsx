import { useEffect, useMemo, useRef } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AttachMenu } from "@/components/AttachMenu";
import { SlashPalette } from "@/components/SlashPalette";
import { AttachmentChips } from "@/components/AttachmentChips";
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
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  disabled,
  streaming,
  capabilities = {},
  sessionFiles = [],
  onAttached = () => {},
}) {
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

  const canSend = !disabled && !streaming && value.trim().length > 0;

  // Files attached during this session. capabilities.files is fetched once at
  // startup, so anything pasted or picked since then is not in it -- without
  // this, a file attached a second ago is not recognised as a file and gets no
  // chip. Still only a *known* name becomes a chip: "@researcher" is an agent
  // and "@notafile" is ordinary text the server will leave alone.
  const known = useMemo(
    () => [...new Set([...(capabilities.files ?? []), ...sessionFiles])],
    [capabilities.files, sessionFiles],
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

  const pickFiles = async () => {
    const names = (await window.maple?.pickFiles()) ?? [];
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
    return window.maple?.saveImage(file.name || "pasted.png", btoa(binary));
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
          ? await window.maple?.importFile(paths[i])
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

      <AttachMenu
        capabilities={capabilities}
        onInsertMention={insertMention}
        onInsertSkill={insertSkill}
        onPickFiles={pickFiles}
        disabled={disabled || streaming}
      />

      <Textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={streaming}
        placeholder="Message Enio…"
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
