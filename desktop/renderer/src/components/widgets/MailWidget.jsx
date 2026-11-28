import { useCallback, useEffect, useState } from "react";
import { Mail, Pencil, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const AGENT_BASE = "http://127.0.0.1:8787";

/**
 * A message Enio wrote, waiting for a person to send it.
 *
 * Enio cannot send mail: the tool writes a draft and stops, and this card
 * is where it leaves from. So the card is not a preview of something that
 * already happened. Send is the act, and it sends the stored message, not
 * the text in the reply above it -- which is why the card asks the server
 * what the message is now instead of trusting the props it was drawn
 * with: it may have been edited in another window, replaced by a newer
 * version, or sent from a terminal.
 *
 * Every edit is saved to the stored message before anything is sent, and
 * a send names the revision that was on screen. What was read is what
 * goes.
 *
 *   enio:outbox-changed  any card → every card: look again
 *   enio:flow-outcome    this card → thread: the reply to append
 */
export function MailWidget({ id, sessionId = null, ...first }) {
  const [draft, setDraft] = useState({ status: "pending", ...first });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // The sheet's own copy, so typing is not a request per key.
  const [form, setForm] = useState(null);

  const api = useCallback(async (path, init) => {
    const token = await window.maple?.getToken();
    const res = await fetch(`${AGENT_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    // A refusal can carry the draft as it now stands (a failed send does):
    // show that, or the next press would name a revision that has moved.
    if (data?.draft) setDraft(data.draft);
    if (!res.ok) throw new Error(data?.error?.message ?? `Failed (${res.status})`);
    return data;
  }, []);

  const refresh = useCallback(() => {
    api(`/outbox/${id}`).catch(() => {
      /* The card keeps what it was drawn with; a press will say why. */
    });
  }, [api, id]);

  useEffect(() => {
    refresh();
    // A newer version of this message may just have been written: the
    // older card has to stop offering to send.
    window.dispatchEvent(new CustomEvent("enio:outbox-changed", { detail: { from: id } }));
    const onChanged = (e) => {
      if (e.detail?.from !== id) refresh();
    };
    window.addEventListener("enio:outbox-changed", onChanged);
    return () => window.removeEventListener("enio:outbox-changed", onChanged);
  }, [id, refresh]);

  const waiting = draft.status === "pending";
  const to = draft.to ?? [];
  const cc = draft.cc ?? [];
  const dirty =
    form !== null &&
    (form.to !== to.join(", ") ||
      form.cc !== cc.join(", ") ||
      form.subject !== draft.subject ||
      form.body !== draft.body);

  const openSheet = () => {
    setForm({ to: to.join(", "), cc: cc.join(", "), subject: draft.subject ?? "", body: draft.body ?? "" });
    setError("");
    setOpen(true);
  };

  /** Write the sheet's text to the stored message. Returns the revision a
   *  send should name, or null when the edit was refused. */
  const save = async () => {
    if (!dirty) return draft.revision;
    const data = await api(`/outbox/${id}`, {
      method: "PUT",
      body: JSON.stringify({ revision: draft.revision, ...form }),
    });
    setForm({
      to: data.draft.to.join(", "),
      cc: data.draft.cc.join(", "),
      subject: data.draft.subject,
      body: data.draft.body,
    });
    return data.draft.revision;
  };

  const settle = (data) => {
    setForm(null);
    window.dispatchEvent(new CustomEvent("enio:outbox-changed", { detail: { from: id } }));
    if (data.reply && (data.draft?.sessionId ?? sessionId)) {
      window.dispatchEvent(
        new CustomEvent("enio:flow-outcome", {
          detail: { sessionId: data.draft?.sessionId ?? sessionId, reply: data.reply },
        }),
      );
    }
    setOpen(false);
  };

  const run = async (what, work) => {
    if (busy) return false;
    setBusy(what);
    setError("");
    try {
      await work();
      return true;
    } catch (err) {
      setError(String(err?.message ?? err));
      // A refusal means the card is behind (edited, sent or discarded
      // somewhere else): look again, so the next press names what is there.
      refresh();
      return false;
    } finally {
      setBusy("");
    }
  };

  const send = () =>
    run("send", async () => {
      // Edits go first, wherever the button is: text typed in the sheet
      // and not yet saved is still what the person last read.
      const revision = dirty ? await save() : draft.revision;
      settle(await api(`/outbox/${id}/send`, { method: "POST", body: JSON.stringify({ revision }) }));
    });

  // Closing the sheet keeps what was typed: saved to the stored message,
  // so the card's Send cannot send the text from before the edit. If the
  // save is refused the sheet stays open with the reason.
  const closeSheet = async (next) => {
    if (next) return setOpen(true);
    if (dirty && waiting) {
      const saved = await run("save", save);
      if (!saved) return;
    }
    setOpen(false);
    setForm(null);
  };
  const discard = () =>
    run("discard", async () => settle(await api(`/outbox/${id}/discard`, { method: "POST", body: "{}" })));

  const whom = to.length === 1 ? to[0] : `${to.length} people`;
  const status = {
    pending: draft.edited ? "Not sent · you changed it" : "Not sent · waiting for you",
    sending: "Sending…",
    sent: "Sent",
    discarded: "Discarded · nothing was sent",
    replaced: "Replaced by a newer version below",
  }[draft.status];
  const sendLabel = busy === "send" ? "Sending…" : `Send to ${whom}`;
  // Said before the press, not after it.
  const off = draft.sendingOn === false;

  return (
    <>
      <div className="my-2 rounded-md border px-3 py-2">
        <div className="flex items-center gap-3">
          <Mail className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{draft.subject}</p>
            <p className="truncate text-xs text-muted-foreground">
              To {to.join(", ")}
              {cc.length > 0 ? ` · cc ${cc.join(", ")}` : ""} · {status}
            </p>
          </div>
          {waiting ? (
            <div className="flex shrink-0 items-center gap-1">
              <Button size="sm" disabled={off || busy !== ""} onClick={send}>
                <Send className="mr-1 size-3.5" />
                {sendLabel}
              </Button>
              <Button size="sm" variant="outline" disabled={busy !== ""} onClick={openSheet}>
                <Pencil className="mr-1 size-3.5" />
                Edit
              </Button>
              <Button size="sm" variant="ghost" disabled={busy !== ""} onClick={discard}>
                <X className="mr-1 size-3.5" />
                Discard
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" onClick={openSheet}>
              View
            </Button>
          )}
        </div>
        {waiting && off && (
          <p className="mt-1.5 text-xs text-muted-foreground">
            Sending is switched off on this machine. Start Enio with ENIO_EMAIL_SEND=1 to send; until
            then this stays here as a draft.
          </p>
        )}
        {waiting && draft.ccNote && (
          <p className="mt-1.5 text-xs text-amber-600">{draft.ccNote}</p>
        )}
        {waiting && draft.lastError && (
          <p className="mt-1.5 text-xs text-destructive">{draft.lastError}</p>
        )}
        {!open && error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
      </div>

      <Sheet open={open} onOpenChange={closeSheet}>
        <SheetContent className="w-full sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{waiting ? "Send this message?" : status}</SheetTitle>
            <SheetDescription>
              From {draft.sender ?? draft.from}
              {waiting ? ". What you see here is what will be sent." : ""}
            </SheetDescription>
          </SheetHeader>

          {form && (
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4">
              {[
                ["to", "To"],
                ["cc", "Cc"],
                ["subject", "Subject"],
              ].map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="w-14 shrink-0">{label}</span>
                  <input
                    value={form[key]}
                    readOnly={!waiting}
                    spellCheck={key === "subject"}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                    className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm text-foreground"
                  />
                </label>
              ))}
              <textarea
                value={form.body}
                readOnly={!waiting}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                className="min-h-[240px] w-full flex-1 resize-y rounded-md border bg-background px-3 py-2 text-sm leading-relaxed outline-none"
              />
              {draft.result && !waiting && (
                <p className="text-xs text-muted-foreground">{draft.result}</p>
              )}
              {waiting && draft.ccNote && <p className="text-xs text-amber-600">{draft.ccNote}</p>}
              {waiting && draft.lastError && (
                <p className="text-xs text-destructive">{draft.lastError}</p>
              )}
              {waiting && off && (
                <p className="text-xs text-muted-foreground">
                  Sending is switched off on this machine (ENIO_EMAIL_SEND=1 turns it on). Changes
                  are still saved.
                </p>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          )}

          <SheetFooter className="flex-row flex-wrap items-center gap-2">
            {waiting ? (
              <>
                <Button disabled={off || busy !== ""} onClick={send}>
                  <Send className="mr-1 size-3.5" />
                  {sendLabel}
                </Button>
                <Button
                  variant="outline"
                  disabled={!dirty || busy !== ""}
                  onClick={() => run("save", save)}
                >
                  {busy === "save" ? "Saving…" : "Save changes"}
                </Button>
                <Button variant="ghost" disabled={busy !== ""} onClick={discard}>
                  <X className="mr-1 size-3.5" />
                  Discard
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => closeSheet(false)}>
                Close
              </Button>
            )}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
