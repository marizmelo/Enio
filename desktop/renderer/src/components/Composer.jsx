import { useEffect, useRef } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AttachMenu } from "@/components/AttachMenu";
import { SlashPalette } from "@/components/SlashPalette";
import { MentionPalette } from "@/components/MentionPalette";
import {
  appendMention,
  applySlash,
  completeMention,
  mentionQuery,
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

  return (
    <footer className="relative flex shrink-0 items-end gap-2 border-t p-3">
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
        disabled={disabled || streaming}
      />

      <Textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={streaming}
        placeholder="Message Enio…  /skill to invoke one, @ to attach"
        className="max-h-[200px] min-h-[40px] resize-none"
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
