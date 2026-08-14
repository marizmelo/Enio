import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SkillsPanel } from "@/components/SkillsPanel";

/**
 * Skills, at the top level.
 *
 * It started as a tab inside Automations, which put the thing with seven
 * entries two clicks away while a drawer holding none of the user's own had a
 * button of its own. The two surfaces that repeat work are now the two
 * buttons: Automations (flows you built, and the scripts they can reach for)
 * and Skills (know-how, in words).
 */
export function SkillsDialog({ open, onOpenChange }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] w-[70vw] max-w-none flex-col gap-3 sm:max-w-none">
        <DialogHeader className="shrink-0">
          <DialogTitle>Skills</DialogTitle>
          <DialogDescription>
            Know-how Enio can follow — markdown files you own. Type /name in chat to run one
            directly.
          </DialogDescription>
        </DialogHeader>
        <SkillsPanel open={open} />
      </DialogContent>
    </Dialog>
  );
}
