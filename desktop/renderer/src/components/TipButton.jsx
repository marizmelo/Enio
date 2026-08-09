import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * An icon button that explains itself.
 *
 * A native `title` attribute was doing this job, which means a delay of about a
 * second, no styling, and a system tooltip that looks like it belongs to a
 * different application. Everything else here is shadcn; the labels should be
 * too.
 */
export function TipButton({ tip, side = "top", children, ...props }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" variant="ghost" {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>{tip}</TooltipContent>
    </Tooltip>
  );
}
