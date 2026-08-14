import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SkillsPanel } from "@/components/SkillsPanel";
import { CanvasPanel } from "@/components/CanvasPanel";

/**
 * Skills, at the top level.
 *
 * It started as a tab inside Automations, which put the thing with seven
 * entries two clicks away while a drawer holding none of the user's own had a
 * button of its own. The two surfaces that repeat work are now the two
 * buttons: Automations (flows you built, and the scripts they can reach for)
 * and Skills (know-how, in words).
 *
 * Editing happens INSIDE this dialog, list ↔ editor, the way the automations
 * canvas lives inside its own. The first version pinned the SKILL.md to the
 * conversation canvas instead and it read as a category error: that panel is
 * for a document the agent and the chat are working on together, and a skill
 * is configuration — there is no conversation to sit beside. The editor is
 * the same component either way; only its home changed.
 */
export function SkillsDialog({ open, onOpenChange }) {
  const [editing, setEditing] = useState(null);

  // Always reopen on the list: the dialog is a place you come back to, and
  // landing inside whatever was open last is the shape of a lost user.
  useEffect(() => {
    if (open) setEditing(null);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] w-[70vw] max-w-none flex-col gap-3 sm:max-w-none">
        <DialogHeader className="shrink-0">
          <DialogTitle>Skills</DialogTitle>
          <DialogDescription>
            {editing
              ? "Editing this skill. Changes apply on the next message."
              : "Know-how Enio can follow — markdown files you own. Type /name in chat to run one directly."}
          </DialogDescription>
        </DialogHeader>

        {editing ? (
          <>
            <button
              className="-mb-1 shrink-0 self-start text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setEditing(null)}
            >
              ← All skills
            </button>
            {/* No onToggleFull: there is nothing to go fullscreen over, which
                is the whole point of it living here. */}
            <CanvasPanel
              path={`.skill/${editing}`}
              rev={0}
              full
              onClose={() => setEditing(null)}
              className="min-h-0 flex-1 overflow-hidden rounded-md border"
            />
          </>
        ) : (
          <SkillsPanel
            open={open}
            onEdit={setEditing}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
