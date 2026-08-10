import { useState } from "react";
import { Check, ListChecks, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const AGENT_BASE = "http://127.0.0.1:8787";

const KIND_LABEL = { applescript: "AppleScript", shell: "shell", python: "Python" };

/**
 * An action the model wants to take, waiting on the user.
 *
 * The thread gets a small card; the decision happens in a sheet, because
 * approving something that will change the machine deserves the whole panel
 * rather than a button squeezed between messages.
 *
 * Every step shows the exact script that will run, and every step is editable.
 * The summary beside it was written by the model, and the model is the part
 * that has proven unreliable — so what is consented to is the text, not the
 * description of it, and being able to fix the text is the difference between
 * approving and starting over.
 *
 * Each step can also be run on its own. Approving a whole plan to discover
 * whether its third step works is a bad trade once steps have side effects,
 * and worse now that a step can be Python.
 */
export function PlanWidget({ id, summary, steps: proposed = [] }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState("pending");
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [naming, setNaming] = useState(false);
  const [safe, setSafe] = useState(false);
  // Edited copies. The proposal is what arrived; this is what will run.
  const [steps, setSteps] = useState(proposed);
  const [tests, setTests] = useState({});
  const [testing, setTesting] = useState(null);

  const settled = ["approved", "saved", "declined", "failed"].includes(state);
  const edited = JSON.stringify(steps) !== JSON.stringify(proposed);

  const post = async (path, body) => {
    const token = await window.maple?.getToken();
    const res = await fetch(`${AGENT_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message ?? `Failed (${res.status})`);
    return data;
  };

  const act = async (action, extra) => {
    setState("running");
    setError("");
    try {
      // The edited steps travel with the decision: what is on screen is what
      // is being approved.
      const data = await post(`/plans/${id}/${action}`, { ...extra, steps });
      setResults(data.results ?? []);
      setState(data.status ?? "approved");
    } catch (err) {
      setState("pending");
      setError(String(err?.message ?? err));
    }
  };

  const testStep = async (i) => {
    setTesting(i);
    setError("");
    try {
      const data = await post(`/plans/${id}/test`, {
        index: i,
        script: steps[i].script,
        kind: steps[i].kind,
      });
      setTests((t) => ({ ...t, [i]: data }));
    } catch (err) {
      setTests((t) => ({ ...t, [i]: { ok: false, output: String(err?.message ?? err) } }));
    } finally {
      setTesting(null);
    }
  };

  const editStep = (i, script) =>
    setSteps((prev) => prev.map((s, n) => (n === i ? { ...s, script } : s)));

  const label = {
    approved: "Ran",
    saved: "Saved and ran",
    declined: "Declined",
    failed: "Stopped part-way",
  }[state];

  return (
    <>
      <div className="my-2 flex items-center gap-3 rounded-md border px-3 py-2">
        <ListChecks className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{summary}</p>
          <p className="text-xs text-muted-foreground">
            {settled
              ? label
              : `${steps.length} step${steps.length === 1 ? "" : "s"} · nothing has run`}
          </p>
        </div>
        <Button size="sm" variant={settled ? "ghost" : "default"} onClick={() => setOpen(true)}>
          {settled ? "View" : "Review"}
        </Button>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{settled ? label : "Approve this plan?"}</SheetTitle>
            <SheetDescription>{summary}</SheetDescription>
          </SheetHeader>

          {/* The steps, and what each one actually runs. Scrolls on its own so
              the footer's buttons stay reachable on a long plan. */}
          <div className="flex-1 overflow-y-auto px-4">
            <ol className="space-y-3">
              {steps.map((step, i) => {
                const result = results.find((r) => r.step === i + 1);
                const test = tests[i];
                return (
                  <li key={i} className="rounded-md border">
                    <div className="flex items-start gap-2 border-b px-3 py-2">
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] tabular-nums">
                        {i + 1}
                      </span>
                      <p className="min-w-0 flex-1 text-sm">{step.summary}</p>
                      <Badge variant="secondary" className="text-[10px]">
                        {KIND_LABEL[step.kind ?? "applescript"]}
                      </Badge>
                      {result && (
                        <span
                          className={
                            result.ok ? "text-xs text-emerald-600" : "text-xs text-destructive"
                          }
                        >
                          {result.ok ? "ok" : "failed"}
                        </span>
                      )}
                    </div>

                    {settled ? (
                      <pre className="overflow-x-auto bg-muted px-3 py-2 text-[12px] leading-relaxed">
                        <code>{step.script}</code>
                      </pre>
                    ) : (
                      <textarea
                        value={step.script}
                        spellCheck={false}
                        onChange={(e) => editStep(i, e.target.value)}
                        className="min-h-[72px] w-full resize-y bg-muted px-3 py-2 font-mono text-[12px] leading-relaxed outline-none focus:bg-background"
                      />
                    )}

                    {!settled && (
                      <div className="flex items-center gap-2 border-t px-3 py-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={testing !== null || state === "running"}
                          onClick={() => testStep(i)}
                        >
                          {testing === i ? "Running…" : "Test this step"}
                        </Button>
                        {test && (
                          <span
                            className={`text-xs ${test.ok ? "text-emerald-600" : "text-destructive"}`}
                          >
                            {test.ok ? "worked" : "failed"}
                          </span>
                        )}
                      </div>
                    )}

                    {(result || test) && (
                      <pre className="overflow-x-auto border-t px-3 py-2 text-[12px]">
                        <code>{(result ?? test).output}</code>
                      </pre>
                    )}
                  </li>
                );
              })}
            </ol>

            {/* A plan that stopped part-way must say so plainly: the steps
                above it already happened and cannot be assumed undone. */}
            {state === "failed" && (
              <p className="mt-3 text-sm text-destructive">
                Stopped at step {results.length} of {steps.length}. Earlier steps already ran.
              </p>
            )}
            {edited && !settled && (
              <p className="mt-3 text-xs text-muted-foreground">
                Edited. What you see here is what will run.
              </p>
            )}
            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          </div>

          <SheetFooter className="flex-col items-stretch gap-2">
            {settled ? (
              <Button variant="outline" onClick={() => setOpen(false)}>
                Close
              </Button>
            ) : (
              <>
                {naming && (
                  <label className="flex items-start gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={safe}
                      className="mt-0.5"
                      onChange={(e) => setSafe(e.target.checked)}
                    />
                    {/* Vouching, not merely saving. Saving records that it
                        worked; this says you are willing to have it repeat
                        without being asked — and only ever this script. */}
                    <span>
                      Safe to run on its own — let Enio use this recipe without asking, when
                      automatic running is on.
                    </span>
                  </label>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={state === "running"} onClick={() => act("approve")}>
                    <Play className="mr-1 size-3.5" />
                    Run {steps.length === 1 ? "it" : "all steps"}
                  </Button>

                  {naming ? (
                    <>
                      <input
                        autoFocus
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="recipe name"
                        className="h-9 rounded-md border bg-background px-2 text-sm"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && name.trim()) act("save", { name, safe });
                        }}
                      />
                      <Button
                        variant="outline"
                        disabled={!name.trim() || state === "running"}
                        onClick={() => act("save", { name, safe })}
                      >
                        <Check className="mr-1 size-3.5" />
                        Save and run
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={state === "running"}
                      onClick={() => setNaming(true)}
                    >
                      Save as recipe
                    </Button>
                  )}

                  <Button
                    variant="ghost"
                    disabled={state === "running"}
                    onClick={() => act("decline")}
                  >
                    <X className="mr-1 size-3.5" />
                    Decline
                  </Button>
                </div>
              </>
            )}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
