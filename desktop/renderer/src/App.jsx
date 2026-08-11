import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StatusBar } from "@/components/StatusBar";
import { Message } from "@/components/Message";
import { Composer } from "@/components/Composer";
import { EmptyState } from "@/components/EmptyState";
import { streamTurn } from "@/lib/agent";
import { appendMention, attachedFiles, fetchCapabilities } from "@/lib/capabilities";
import { FilesDialog } from "@/components/FilesDialog";
import { FileViewer } from "@/components/FileViewer";
import {
  conversationMessages,
  createConversation,
  listConversations,
  pendingPlans,
} from "@/lib/conversations";
import { HistoryDialog } from "@/components/HistoryDialog";
import { PermissionNotice } from "@/components/PermissionNotice";
import { RecipesDialog } from "@/components/RecipesDialog";
import { speak, stopSpeaking, takeSentences, warmVoice } from "@/lib/speech";

/** "2h ago", for the divider under restored history. */
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

export function App() {
  const [status, setStatus] = useState({
    phase: "starting",
    message: "Starting up…",
  });
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [capabilities, setCapabilities] = useState({});
  // Files attached since startup. capabilities.files is fetched once, so
  // without this a file pasted a moment ago is not recognised as a file --
  // by the composer's chips or by the thread's previews.
  const [sessionFiles, setSessionFiles] = useState([]);
  // Off by default, deliberately. An assistant that starts talking without
  // being asked is startling in a way a silent one never is.
  const [speakReplies, setSpeakReplies] = useState(false);
  // Which stored conversation this thread is. Minted before the first message
  // rather than at send: attachments are filed under it, and they happen while
  // the message is still being written. An id with no messages behind it costs
  // one row and never appears in the list.
  const [conversationId, setConversationId] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [recipesOpen, setRecipesOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  // A file opened from the thread. The arrows walk that message's attachments,
  // because those are the ones the question was about.
  const [viewing, setViewing] = useState(null);
  // How full the model's window is, reported by the server after folding.
  const [context, setContext] = useState(null);

  // Recipes are AppleScript, so the drawer is unfillable off a Mac. Read from
  // the user agent rather than an endpoint because it gates a button that
  // should not flicker into existence a second after the window opens.
  const isMac = navigator.userAgent.includes("Mac");

  const abortRef = useRef(null);
  const composerRef = useRef(null);
  const scrollRef = useRef(null);
  // Whether the thread should follow new content. A ref rather than state
  // because scroll events fire continuously while tokens stream, and the
  // auto-scroll effect only needs to *read* it -- making it state would
  // re-render the whole thread on every wheel tick.
  const followRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  // Status arrives two ways: pushed as it changes, and pulled once on mount.
  // The pull matters because the main process may finish starting the backends
  // before this window has loaded, and those pushes would be lost.
  useEffect(() => {
    if (!window.maple) {
      setStatus({ phase: "failed", message: "Preload bridge unavailable." });
      return;
    }
    const unsubscribe = window.maple.onStatus(setStatus);
    window.maple.getStatus().then((s) => s && setStatus(s));
    return unsubscribe;
  }, []);

  // Follow the answer as it streams -- but only while the user is at the
  // bottom. This used to set scrollTop unconditionally on every message
  // change, and setMessages runs per streamed token, so scrolling up during a
  // reply was undone within milliseconds: the thread could not be read while
  // it was being written.
  useEffect(() => {
    if (!followRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Near the bottom counts as at the bottom. An exact test never matches
  // during streaming, because content is being appended between the scroll
  // and the check, and fractional device pixels mean the numbers rarely land
  // equal even at rest.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    followRef.current = atBottom;
    // React bails out when the value is unchanged, so this costs a render
    // only when crossing the threshold rather than on every tick.
    setShowJump(!atBottom);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    followRef.current = true;
    setShowJump(false);
  }, []);

  const backendReady = status.phase === "ready";

  // Fetched once the agent endpoint is up rather than on mount: before that the
  // token file may not exist yet, and a 401 here would leave the menus empty
  // for the rest of the session with nothing to retry it.
  useEffect(() => {
    if (backendReady) fetchCapabilities().then(setCapabilities);
  }, [backendReady]);

  // A stored transcript, plus any approval still waiting on this conversation.
  // The plan card only ever travelled over the live stream, so without asking
  // the server for pending plans a restart would orphan them: still in the
  // database, no surface left to approve or decline from. Re-derived on every
  // restore — once decided, the card simply stops coming back.
  const restoreThread = useCallback(async (convId) => {
    const transcript = await conversationMessages(convId);
    // Marked so the thread can draw a line under them. A restored transcript
    // is pixel-identical to a live reply, and three separate times now a
    // resumed conversation whose tail happened to be a stalled-looking answer
    // was read as the model failing to respond -- the fix is for history to
    // say it is history.
    const msgs = transcript.map((m) => ({ role: m.role, content: m.content, restored: true }));
    const lastTs = transcript.length > 0 ? transcript[transcript.length - 1].ts : null;
    if (lastTs) msgs[msgs.length - 1].restoredAt = lastTs;
    try {
      const waiting = (await pendingPlans()).filter((p) => p.sessionId === convId);
      if (waiting.length > 0) {
        msgs.push({
          role: "assistant",
          content:
            waiting.length === 1
              ? "This is still waiting for your approval."
              : "These are still waiting for your approval.",
          widgets: waiting.map((p) => ({
            type: "plan",
            id: p.id,
            summary: p.summary,
            steps: p.steps,
          })),
        });
      }
    } catch {
      /* The thread is still usable without the cards. */
    }
    return msgs;
  }, []);

  // Resume the last conversation once the backend is up. The thread you were
  // in comes back as you left it — that is the literal meaning of persisting
  // across restarts. A failure here degrades to an empty chat, never an error.
  useEffect(() => {
    if (!backendReady || conversationId) return;
    (async () => {
      try {
        const all = await listConversations();
        if (all.length === 0) {
          // Nothing to resume, but attaching still needs somewhere to file
          // things — so the thread gets its id now rather than on send.
          setConversationId(await createConversation().catch(() => null));
          return;
        }
        const latest = all[0];
        const msgs = await restoreThread(latest.id);
        setConversationId(latest.id);
        setMessages(msgs);
      } catch {
        /* Fresh chat is the fallback for every failure mode here. */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendReady]);

  const openConversation = useCallback(async (conv) => {
    stopSpeaking();
    followRef.current = true;
    setShowJump(false);
    const msgs = await restoreThread(conv.id).catch(() => []);
    setConversationId(conv.id);
    setMessages(msgs);
  }, [restoreThread]);

  const newChat = useCallback(async () => {
    stopSpeaking();
    followRef.current = true;
    setShowJump(false);
    setMessages([]);
    setContext(null);
    // Created eagerly so the first turn already has an id to log under. An
    // abandoned empty session never shows in the list — it has no messages.
    setConversationId(await createConversation().catch(() => null));
  }, []);

  const send = useCallback(
    async (text) => {
      const trimmed = text.trim();
      if (!trimmed || streaming || !backendReady) return;

      setInput("");
      // Sending re-follows: whatever you were reading, you want to see your
      // own message land and the answer that follows it.
      followRef.current = true;
      setShowJump(false);
      // Recorded on the message so the thread can show what was attached
      // after the composer has been cleared.
      const files = attachedFiles(trimmed, [
        ...(capabilities.files ?? []),
        ...(capabilities.attachments ?? []),
        ...sessionFiles,
      ]);
      const history = [...messages, { role: "user", content: trimmed, files }];
      setMessages([...history, { role: "assistant", content: "", tools: [] }]);
      setStreaming(true);

      // First message of a fresh boot with nothing to resume: create the
      // conversation now so this turn is stored from the start.
      let convId = conversationId;
      if (!convId) {
        convId = await createConversation().catch(() => null);
        setConversationId(convId);
      }

      const controller = new AbortController();
      abortRef.current = controller;

      let assistant = "";
      const tools = [];
      const widgets = [];
      let thinking = 0;
      // Text streamed but not yet handed to the voice.
      let unspoken = "";
      const notices = [];
      // Pages the tools read, in the order they were read. Deduped at render
      // time rather than here, so the search hit that carried a snippet is the
      // one kept when the same page is later fetched in full.
      const sources = [];
      const startedAt = Date.now();

      try {
        for await (const event of streamTurn(
          history.map(({ role, content }) => ({ role, content })),
          controller.signal,
          convId,
        )) {
          if (event.type === "tool") {
            tools.push(event.name);
          } else if (event.type === "sources") {
            sources.push({ tool: event.tool, items: event.items });
          } else if (event.type === "widget") {
            widgets.push(event.widget);
          } else if (event.type === "think") {
            thinking = event.chars;
          } else if (event.type === "context") {
            setContext({ tokens: event.tokens, budget: event.budget });
          } else if (event.type === "notice") {
            if (!notices.includes(event.text)) notices.push(event.text);
          } else {
            // The model opens with a blank line or two once its <think> block
            // is stripped. Trimmed at the front only, and on the accumulated
            // text rather than per delta, because a delta is often a bare
            // space between words and trimming those runs them together.
            assistant = (assistant + event.text).replace(/^\s+/, "");

            // Spoken sentence by sentence as it arrives, so the first words are
            // audible about a second after they appear rather than after the
            // whole answer has finished streaming.
            if (speakReplies) {
              unspoken += event.text;
              const { ready, rest } = takeSentences(unspoken);
              unspoken = rest;
              for (const sentence of ready) speak(sentence);
            }
          }
          setMessages([
            ...history,
            {
              role: "assistant",
              content: assistant,
              tools: [...tools],
              widgets: [...widgets],
              sources: sources.map((s) => ({ ...s })),
              thinking,
              notices: [...notices],
              startedAt,
            },
          ]);
        }

        // Whatever is left over: a final clause with no full stop, or a reply
        // short enough that no sentence ever completed mid-stream.
        if (speakReplies && unspoken.trim()) speak(unspoken);
      } catch (err) {
        if (err?.name === "AbortError") {
          // Keep whatever streamed in as the final turn, so the conversation
          // stays coherent for the next request.
          if (!assistant) {
            setMessages([
              ...history,
              { role: "assistant", content: "Stopped.", tools, error: true },
            ]);
          }
        } else {
          setMessages([
            ...history,
            { role: "assistant", content: String(err?.message ?? err), tools, error: true },
          ]);
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [backendReady, capabilities.files, conversationId, messages, sessionFiles, speakReplies, streaming],
  );

  return (
    <TooltipProvider delayDuration={300}>
    <div className="flex h-screen flex-col bg-background">
      <StatusBar
        {...status}
        context={context}
        onNewChat={newChat}
        onHistory={() => setHistoryOpen(true)}
        onRecipes={isMac ? () => setRecipesOpen(true) : undefined}
        onFiles={() => setFilesOpen(true)}
      />

      <RecipesDialog open={recipesOpen} onOpenChange={setRecipesOpen} />

      {viewing && (
        <FileViewer
          open
          files={viewing.files}
          index={viewing.index}
          onIndex={(index) => setViewing((v) => ({ ...v, index }))}
          onOpenChange={(next) => !next && setViewing(null)}
        />
      )}

      <FilesDialog
        open={filesOpen}
        onOpenChange={setFilesOpen}
        conversationId={conversationId}
        onReuse={(paths) => {
          setSessionFiles((prev) => [...new Set([...prev, ...paths])]);
          setInput((value) => paths.reduce(appendMention, value));
          setFilesOpen(false);
        }}
      />

      <HistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        currentId={conversationId}
        onPick={openConversation}
        onDiscarded={(id) => {
          // Discarding took its attachments with it, so this thread cannot
          // keep the id — the folder it was filing into is gone.
          if (id === conversationId) newChat();
        }}
      />

      <div className="relative flex min-h-0 flex-1 flex-col">
      <main ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <EmptyState onPick={send} disabled={!backendReady} />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-5">
            {messages.map((m, i) => (
              <Fragment key={i}>
                <Message
                  {...m}
                  streaming={streaming && i === messages.length - 1 && m.role === "assistant"}
                  onOpenFile={(names, index) =>
                    setViewing({ files: names.map((path) => ({ path })), index })
                  }
                />
                {/* The line under history. Without it a resumed transcript is
                    pixel-identical to a live reply, and a tail that happens to
                    read like a stall gets mistaken for one. */}
                {m.restored && !messages[i + 1]?.restored && (
                  <div className="flex items-center gap-3 py-1 text-[11px] text-muted-foreground">
                    <div className="h-px flex-1 bg-border" />
                    earlier conversation{m.restoredAt ? ` · ${ago(m.restoredAt)}` : ""}
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
              </Fragment>
            ))}
          </div>
        )}
      </main>

      {/* Only while scrolled away: leaving it up permanently would be a button
          that does nothing most of the time. */}
      {showJump && (
        <button
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border bg-background px-3 py-1 text-xs shadow-sm hover:bg-muted"
        >
          Jump to latest ↓
        </button>
      )}
      </div>

      {/* Above the composer rather than in the thread: it is a property of the
          app, not of anything that was said, and it must not scroll away. */}
      <div className="shrink-0 px-4 pb-2">
        <PermissionNotice backendReady={backendReady} />
      </div>

      <Composer
        ref={composerRef}
        value={input}
        onChange={setInput}
        onSend={(text) => send(text ?? input)}
        onStop={() => abortRef.current?.abort()}
        disabled={!backendReady}
        streaming={streaming}
        capabilities={capabilities}
        sessionFiles={sessionFiles}
        conversationId={conversationId}
        onAttached={(names) =>
          setSessionFiles((prev) => [...new Set([...prev, ...names])])
        }
        speakReplies={speakReplies}
        onToggleSpeak={() => {
          if (speakReplies) stopSpeaking();
          // Switching it on is the earliest moment we know speech will be
          // wanted, and the user is about to spend a while typing or reading
          // -- which is exactly the load time we would otherwise spend after
          // the answer has already arrived.
          else warmVoice();
          setSpeakReplies((on) => !on);
        }}
      />
    </div>
    </TooltipProvider>
  );
}
