import { useState } from "react";
import { Check, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const AGENT_BASE = "http://127.0.0.1:8787";

/**
 * An action the model wants to take, waiting on the user.
 *
 * The script is shown in full rather than summarised. The summary is written
 * by the model, and the model is the part that has proven unreliable — so what
 * gets consented to is the exact text that will run, not a description of it.
 *
 * "Save as recipe" is the half that compounds: an approved script becomes a
 * named recipe the model selects next time instead of composing again, which
 * is the only way a thing that worked once keeps working at this model size.
 */
export function PlanWidget({ id, summary, script }) {
  const [state, setState] = useState("pending");
  const [output, setOutput] = useState("");
  const [name, setName] = useState("");
  const [naming, setNaming] = useState(false);

  const act = async (action, body) => {
    setState("running");
    try {
      const token = await window.maple?.getToken();
      const res = await fetch(`${AGENT_BASE}/plans/${id}/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState("error");
        setOutput(data?.error?.message ?? `Failed (${res.status})`);
        return;
      }
      setState(data.status === "failed" ? "error" : data.status);
      setOutput(data.output ?? "");
    } catch (err) {
      setState("error");
      setOutput(String(err?.message ?? err));
    }
  };

  const settled = ["approved", "saved", "declined", "error"].includes(state);

  return (
    <div className="my-2 overflow-hidden rounded-md border">
      <div className="border-b bg-muted/60 px-3 py-2">
        <p className="text-xs font-medium text-muted-foreground">
          Waiting for your approval — nothing has run
        </p>
        <p className="mt-0.5 text-sm">{summary}</p>
      </div>

      <pre className="max-h-56 overflow-auto bg-muted p-3 text-[13px] leading-relaxed">
        <code>{script}</code>
      </pre>

      {state === "declined" && (
        <p className="px-3 py-2 text-xs text-muted-foreground">Declined. Nothing ran.</p>
      )}

      {output && (
        <pre className="max-h-40 overflow-auto border-t px-3 py-2 text-[13px]">
          <code>{output}</code>
        </pre>
      )}

      {!settled && (
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
          <Button size="sm" disabled={state === "running"} onClick={() => act("approve")}>
            <Play className="mr-1 size-3.5" />
            Run once
          </Button>

          {naming ? (
            <>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="recipe name"
                className="h-8 rounded-md border bg-background px-2 text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim()) act("save", { name });
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!name.trim() || state === "running"}
                onClick={() => act("save", { name })}
              >
                <Check className="mr-1 size-3.5" />
                Save and run
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={state === "running"}
              onClick={() => setNaming(true)}
            >
              Save as recipe
            </Button>
          )}

          <Button
            size="sm"
            variant="ghost"
            disabled={state === "running"}
            onClick={() => act("decline")}
          >
            <X className="mr-1 size-3.5" />
            Decline
          </Button>
        </div>
      )}
    </div>
  );
}
