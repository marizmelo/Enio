import { Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * A draft plan for a request that takes more than one agent.
 *
 * Small on purpose. The reply above already lists the steps, and everything
 * someone does with a plan — change a step, run it, read what each step
 * did, save it — already lives on the Automations canvas. So this is only
 * the door: it hands the draft to that dialog rather than growing a second,
 * poorer editor in the thread.
 *
 * An event rather than a prop threaded through the message: the dialog is
 * mounted once at the top of the app, and a card can sit anywhere in a
 * thread, restored ones included.
 */
export function FlowWidget({ request, nodes = [], edges = [] }) {
  if (nodes.length === 0) return null;
  const agents = new Set(nodes.map((n) => n.agent)).size;
  const open = () =>
    window.dispatchEvent(new CustomEvent("enio:open-flow", { detail: { request, nodes, edges } }));
  return (
    <div className="my-2 flex items-center gap-3 rounded-md border px-3 py-2">
      <Workflow className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{request}</p>
        <p className="text-xs text-muted-foreground">
          {nodes.length} step{nodes.length === 1 ? "" : "s"}
          {agents > 1 ? ` · ${agents} agents` : ""} · nothing has run
        </p>
      </div>
      <Button size="sm" onClick={open}>
        Review and run
      </Button>
    </div>
  );
}
