import { Clock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * A time, shown rather than described.
 *
 * Derives its two lines from the string the tool already formatted instead of
 * re-formatting from the ISO value: the tool resolved the zone, and formatting
 * twice invites the widget and the sentence above it to disagree by a minute.
 *
 * The split is on the time itself rather than on punctuation. en-GB renders
 * "Saturday 8 August 2026 at 15:14" with no comma at all, so splitting on ", "
 * put the whole string in both lines.
 */
export function ClockWidget({ label, zone }) {
  const match = /(\d{1,2}:\d{2})/.exec(label);
  const time = match ? match[1] : label;
  // Trailing "at" and any leftover punctuation both have to go: en-GB leaves
  // "... 2026 at", and a locale that puts the time last leaves a comma.
  const date = match
    ? label.replace(match[1], "").replace(/\s*\bat\b\s*$/, "").replace(/[\s,]+$/, "")
    : "";

  return (
    <Card className="flex flex-row items-center gap-3 px-3.5 py-3">
      <Clock className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="text-lg font-semibold leading-none tabular-nums">{time}</div>
        {date && <div className="mt-1 truncate text-xs text-muted-foreground">{date}</div>}
      </div>
      <Badge variant="secondary" className="ml-auto shrink-0 font-mono text-[11px]">
        {zone}
      </Badge>
    </Card>
  );
}
