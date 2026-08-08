import { useCallback, useEffect, useRef, useState } from "react";
import { StatusBar } from "@/components/StatusBar";
import { Message } from "@/components/Message";
import { Composer } from "@/components/Composer";
import { EmptyState } from "@/components/EmptyState";
import { streamTurn } from "@/lib/agent";
import { fetchCapabilities } from "@/lib/capabilities";

export function App() {
  const [status, setStatus] = useState({
    phase: "starting",
    message: "Starting up…",
  });
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [capabilities, setCapabilities] = useState({});

  const abortRef = useRef(null);
  const scrollRef = useRef(null);

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

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const backendReady = status.phase === "ready";

  // Fetched once the agent endpoint is up rather than on mount: before that the
  // token file may not exist yet, and a 401 here would leave the menus empty
  // for the rest of the session with nothing to retry it.
  useEffect(() => {
    if (backendReady) fetchCapabilities().then(setCapabilities);
  }, [backendReady]);

  const send = useCallback(
    async (text) => {
      const trimmed = text.trim();
      if (!trimmed || streaming || !backendReady) return;

      setInput("");
      const history = [...messages, { role: "user", content: trimmed }];
      setMessages([...history, { role: "assistant", content: "", tools: [] }]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      let assistant = "";
      const tools = [];
      const widgets = [];

      try {
        for await (const event of streamTurn(
          history.map(({ role, content }) => ({ role, content })),
          controller.signal,
        )) {
          if (event.type === "tool") {
            tools.push(event.name);
          } else if (event.type === "widget") {
            widgets.push(event.widget);
          } else {
            // The model opens with a blank line or two once its <think> block
            // is stripped. Trimmed at the front only, and on the accumulated
            // text rather than per delta, because a delta is often a bare
            // space between words and trimming those runs them together.
            assistant = (assistant + event.text).replace(/^\s+/, "");
          }
          setMessages([
            ...history,
            {
              role: "assistant",
              content: assistant,
              tools: [...tools],
              widgets: [...widgets],
            },
          ]);
        }
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
    [backendReady, messages, streaming],
  );

  return (
    <div className="flex h-screen flex-col bg-background">
      <StatusBar {...status} />

      <main ref={scrollRef} className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <EmptyState onPick={send} disabled={!backendReady} />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-5">
            {messages.map((m, i) => (
              <Message
                key={i}
                {...m}
                streaming={streaming && i === messages.length - 1 && m.role === "assistant"}
              />
            ))}
          </div>
        )}
      </main>

      <Composer
        value={input}
        onChange={setInput}
        onSend={() => send(input)}
        onStop={() => abortRef.current?.abort()}
        disabled={!backendReady}
        streaming={streaming}
        capabilities={capabilities}
      />
    </div>
  );
}
