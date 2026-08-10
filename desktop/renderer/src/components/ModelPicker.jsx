import { useCallback, useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { currentModel, switchModel } from "@/lib/recipes";

/**
 * Which model the machine runs, switchable from the window.
 *
 * The list is closed on purpose: the bundled default plus models already
 * downloaded. Switching restarts the model server underneath the agent while
 * the agent — and this window's session — stays up. The wait is real (a model
 * is gigabytes read off disk), so the picker says so instead of freezing.
 */
export function ModelPicker({ backendReady }) {
  const [current, setCurrent] = useState(null);
  const [available, setAvailable] = useState([]);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const data = await currentModel();
      setCurrent(data.current);
      setAvailable(data.available ?? []);
    } catch {
      setCurrent(null);
    }
  }, []);

  useEffect(() => {
    if (backendReady) refresh();
  }, [backendReady, refresh]);

  if (!current) return null;

  const shortName = (id) => (id === "maple" ? "Maple" : id.split("/").pop());

  const pick = async (id) => {
    if (id === current || switching) return;
    setSwitching(true);
    setError("");
    try {
      await switchModel(id);
      setCurrent(id);
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted [-webkit-app-region:no-drag]"
        disabled={switching}
        title={error || undefined}
      >
        <Cpu className="size-3" />
        {switching ? "switching…" : shortName(current)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="text-xs">
          Model — switching reloads the weights (a minute or so)
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {available.map((id) => (
          <DropdownMenuItem
            key={id}
            disabled={switching}
            onClick={() => pick(id)}
            className="text-xs"
          >
            <span className="w-3">{id === current ? "•" : ""}</span>
            {shortName(id)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
