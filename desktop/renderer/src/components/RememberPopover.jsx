import { useEffect, useState } from "react";
import { Brain, Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { distilFacts, rememberFacts } from "@/lib/memory";

/**
 * "Remember this", under a reply.
 *
 * Automatic extraction is the model deciding what mattered; a user pressing
 * this is a much better signal, and it is the only way an ANSWER (as opposed
 * to something the user said about themselves) gets into memory on purpose.
 * The reply is distilled server-side into short standalone facts, and they
 * are shown here for pruning and editing BEFORE anything is written -- what
 * lands in memory is what the user read and ticked, not what the model
 * emitted. A bad distillation costs a glance, never a bad memory.
 */
export function RememberPopover({ question, answer, sessionId, onClose }) {
  const [state, setState] = useState("loading"); // loading | pick | saving | done | error
  const [facts, setFacts] = useState([]);
  const [checked, setChecked] = useState([]);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    distilFacts(question, answer)
      .then((d) => {
        if (cancelled) return;
        setFacts(d.facts ?? []);
        setChecked((d.facts ?? []).map(() => true));
        setState("pick");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err?.message ?? err));
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [question, answer]);

  const save = async () => {
    const chosen = facts.filter((_, i) => checked[i]).map((f) => f.trim()).filter(Boolean);
    if (chosen.length === 0) return;
    setState("saving");
    try {
      setResult(await rememberFacts(chosen, sessionId));
      setState("done");
    } catch (err) {
      setError(String(err?.message ?? err));
      setState("error");
    }
  };

  return (
    <div className="mt-1 w-full max-w-[85%] rounded-md border bg-background p-3 text-xs shadow-sm">
      <div className="mb-2 flex items-center gap-2">
        <Brain className="size-3.5 text-emerald-600" />
        <span className="font-medium">
          {state === "loading" && "Reading the answer for facts worth keeping…"}
          {state === "pick" && "Remember these?"}
          {state === "saving" && "Saving…"}
          {state === "done" && "Remembered."}
          {state === "error" && "Could not remember this."}
        </span>
        <button className="ml-auto text-muted-foreground hover:text-foreground" onClick={onClose} title="Close">
          <X className="size-3.5" />
        </button>
      </div>

      {state === "loading" && <Loader2 className="size-4 animate-spin text-muted-foreground" />}

      {state === "pick" && (
        <>
          <ul className="space-y-1.5">
            {facts.map((f, i) => (
              <li key={i} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={checked[i]}
                  onChange={(e) =>
                    setChecked((prev) => prev.map((c, j) => (j === i ? e.target.checked : c)))
                  }
                />
                {/* Editable in place: the distillation is a draft, and the
                    fact that lands is the one the user finished. */}
                <input
                  className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5"
                  value={f}
                  onChange={(e) =>
                    setFacts((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
                  }
                />
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" className="h-7 gap-1 px-2.5" disabled={!checked.some(Boolean)} onClick={save}>
              <Check className="size-3.5" /> Remember {checked.filter(Boolean).length}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClose}>
              Cancel
            </Button>
            <span className="ml-auto text-muted-foreground">
              Kept as facts in Memory — this conversation is where they came from.
            </span>
          </div>
        </>
      )}

      {state === "done" && result && (
        <p className="text-muted-foreground">
          {result.stored.length} saved
          {result.skipped.length > 0 && ` · ${result.skipped.length} already known`}. Find them under Memory.
        </p>
      )}

      {state === "error" && <p className="text-destructive">{error}</p>}
    </div>
  );
}
