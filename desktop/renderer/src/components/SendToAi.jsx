import { useEffect, useState } from "react";
import { ArrowUpRight, Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The last step of a handoff, made one click instead of four.
 *
 * "Send" is deliberately modest: copy the file to the clipboard and open the
 * chosen AI — its desktop app when one is installed, its web app when not.
 * The prompt still leaves this machine by the user pasting it, under their
 * own account, after reading it; this button removes the errand, not the
 * decision. (URL prefill and API calls were both rejected — see main.js.)
 *
 * The default is whichever provider was used last, kept in localStorage:
 * it is a UI habit, not machine policy, and it should not survive into
 * another user's config the way ~/.enio state does.
 */
const DEFAULT_KEY = "ai-provider";

let cached = null;
async function providers() {
  cached ??= (await window.maple?.aiProviders?.()) ?? [];
  return cached;
}

export function SendToAi({ path }) {
  const [list, setList] = useState([]);
  const [defaultId, setDefaultId] = useState(
    () => localStorage.getItem(DEFAULT_KEY) ?? "claude",
  );
  const [sent, setSent] = useState(null);

  useEffect(() => {
    providers().then(setList);
  }, []);

  if (list.length === 0) return null;
  const chosen = list.find((p) => p.id === defaultId) ?? list[0];

  const send = async (provider) => {
    const result = await window.maple?.sendToAi?.(provider.id, path);
    if (!result) return;
    localStorage.setItem(DEFAULT_KEY, provider.id);
    setDefaultId(provider.id);
    // The clipboard is the part that is easy to miss — the browser opening
    // is obvious, the paste being ready is not.
    setSent(`Copied — paste into ${result.name}`);
    setTimeout(() => setSent(null), 4000);
  };

  return (
    <div className="flex max-w-[85%] items-center gap-1.5">
      <div className="inline-flex overflow-hidden rounded-md border">
        <button
          type="button"
          onClick={() => send(chosen)}
          title={`Copy the handoff and open ${chosen.name}`}
          className="inline-flex items-center gap-1.5 bg-muted/40 px-2.5 py-1.5 text-xs hover:bg-muted"
        >
          {sent ? <Check className="size-3.5" /> : <ArrowUpRight className="size-3.5" />}
          {sent ?? `Send to ${chosen.name}`}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Choose an AI"
              className="inline-flex items-center border-l bg-muted/40 px-1.5 hover:bg-muted"
            >
              <ChevronDown className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {list.map((p) => (
              <DropdownMenuItem key={p.id} onSelect={() => send(p)}>
                {p.name}
                {p.installed && (
                  <span className="ml-auto pl-3 text-[10px] text-muted-foreground">
                    installed
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
