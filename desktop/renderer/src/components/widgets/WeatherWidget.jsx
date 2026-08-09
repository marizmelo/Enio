import { Cloud, CloudRain, CloudSun, Snowflake, Sun, Zap } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/** Picked from the condition words, so a new WMO code still gets a sensible icon. */
function iconFor(condition) {
  const c = condition.toLowerCase();
  if (c.includes("thunder")) return Zap;
  if (c.includes("snow")) return Snowflake;
  if (c.includes("rain") || c.includes("drizzle") || c.includes("shower")) return CloudRain;
  if (c.includes("clear")) return Sun;
  if (c.includes("partly") || c.includes("mainly")) return CloudSun;
  return Cloud;
}

export function WeatherWidget({ place, condition, temperature, feelsLike, high, low, rainChance }) {
  const Icon = iconFor(condition);

  return (
    <Card className="flex flex-row items-center gap-3 px-3.5 py-3">
      <Icon className="size-6 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tabular-nums leading-none">{temperature}°</span>
          <span className="truncate text-sm text-muted-foreground">{condition}</span>
        </div>
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {place} · feels {feelsLike}° · {low}–{high}°
        </div>
      </div>
      {rainChance > 0 && (
        <Badge variant="secondary" className="ml-auto shrink-0 tabular-nums">
          {rainChance}% rain
        </Badge>
      )}
    </Card>
  );
}
