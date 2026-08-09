import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";

/**
 * What the model is doing while there is nothing to show.
 *
 * The wait before the first visible token is the model reasoning inside a
 * <think> block that gets stripped, and it can run for a minute. A spinner
 * alone cannot distinguish that from a hang, so this reports both how long it
 * has been going and how much has been produced.
 *
 * The token figure is derived from character count and labelled with a tilde.
 * The server sends the size of the reasoning, never the text — a real count
 * would mean tokenising in the renderer, and four characters per token is close
 * enough to answer the only question being asked, which is "is it moving".
 */
export function Thinking({ startedAt, chars = 0 }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const seconds = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1000));
  const tokens = Math.round(chars / 4);

  return (
    <div className="flex max-w-[85%] items-center gap-2 rounded-lg bg-muted px-3.5 py-2.5 text-sm text-muted-foreground">
      <Spinner />
      <span>Thinking</span>
      <span className="tabular-nums">{seconds}s</span>
      {tokens > 0 && <span className="tabular-nums">· ~{tokens.toLocaleString()} tokens</span>}
    </div>
  );
}
