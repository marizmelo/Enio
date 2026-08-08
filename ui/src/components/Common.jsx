import React from "react";
import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge as ShadBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Shared primitives, now backed by shadcn.
 *
 * The exported names and props are unchanged on purpose: ten components import
 * from here, and a migration that also rewrote every call site would make it
 * impossible to tell a styling regression from a logic one.
 */

export function Spinner({ label = "Loading" }) {
  return (
    <div className="flex items-center gap-3 p-4" role="status" aria-live="polite">
      <Skeleton className="size-4 rounded-full" />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}

export function ErrorBanner({ error, onRetry }) {
  if (!error) return null;
  const message = typeof error === "string" ? error : error.message || "Something went wrong.";
  return (
    <Alert variant="destructive" className="flex items-center gap-3">
      <CircleAlert className="size-4" />
      <AlertDescription className="flex-1">{message}</AlertDescription>
      {onRetry && (
        <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </Alert>
  );
}

export function EmptyState({ title, hint, children }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
      <div className="text-sm font-medium">{title}</div>
      {hint && <div className="max-w-md text-sm text-muted-foreground">{hint}</div>}
      {children}
    </div>
  );
}

// The inspector's tones predate shadcn's variants and carry meaning the
// variants do not: "warning" is a turn that recovered, "danger" is one that
// failed. Mapped rather than replaced.
const TONE = {
  default: { variant: "secondary", className: "" },
  accent: { variant: "default", className: "" },
  warning: {
    variant: "outline",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  },
  danger: { variant: "destructive", className: "" },
  muted: { variant: "outline", className: "text-muted-foreground" },
};

export function Badge({ tone = "default", children, title }) {
  const { variant, className } = TONE[tone] ?? TONE.default;
  return (
    <ShadBadge variant={variant} className={cn("font-normal", className)} title={title}>
      {children}
    </ShadBadge>
  );
}
