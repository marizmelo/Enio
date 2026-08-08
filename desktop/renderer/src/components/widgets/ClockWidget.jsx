import { Clock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * A time, shown rather than described.
 *
 * Splits the formatted string the tool already produced instead of
 * re-formatting from the ISO value: the tool resolved the zone, and doing that
 * twice invites the widget and the sentence above it to disagree by a minute.
 */
export function ClockWidget({ label, zone }) {
  const [weekday, ...rest] = label.split(", ");
  const remainder = rest.join(", ");
  const timeMatch = /(\d{1,2}:\d{2})/.exec(remainder);

  return (
    <Card className="flex flex-row items-center gap-3 px-3.5 py-3">
      <Clock className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="text-lg font-semibold tabular-nums leading-none">
          {timeMatch ? timeMatch[1] : label}
        </div>
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {weekday}
          {remainder && timeMatch ? `, ${remainder.replace(timeMatch[1], "").replace(/\s+at\s*$/, "").trim()}` : ""}
        </div>
      </div>
      <Badge variant="secondary" className="ml-auto shrink-0 font-mono text-[11px]">
        {zone}
      </Badge>
    </Card>
  );
}
