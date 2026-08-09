import { useCallback, useEffect, useRef, useState } from "react";
import { StatusBar } from "@/components/StatusBar";
import { Message } from "@/components/Message";
import { Composer } from "@/components/Composer";
import { EmptyState } from "@/components/EmptyState";
import { streamTurn } from "@/lib/agent";
import { attachedFiles, fetchCapabilities } from "@/lib/capabilities";
import { speak, stopSpeaking, takeSentences } from "@/lib/speech";

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
      // Recorded on the message so the thread can show what was attached
      // after the composer has been cleared.
      const files = attachedFiles(trimmed, [...(capabilities.files ?? []), ...sessionFiles]);
      const history = [...messages, { role: "user", content: trimmed, files }];
      setMessages([...history, { role: "assistant", content: "", tools: [] }]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      let assistant = "";
      const tools = [];
      const widgets = [];
      let thinking = 0;
      // Text streamed but not yet handed to the voice.
      let unspoken = "";
      const notices = [];
      const startedAt = Date.now();

      try {
        for await (const event of streamTurn(
          history.map(({ role, content }) => ({ role, content })),
          controller.signal,
        )) {
          if (event.type === "tool") {
            tools.push(event.name);
          } else if (event.type === "widget") {
            widgets.push(event.widget);
          } else if (event.type === "think") {
            thinking = event.chars;
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
    [backendReady, capabilities.files, messages, sessionFiles, speakReplies, streaming],
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
        onSend={(text) => send(text ?? input)}
        onStop={() => abortRef.current?.abort()}
        disabled={!backendReady}
        streaming={streaming}
        capabilities={capabilities}
        sessionFiles={sessionFiles}
        onAttached={(names) =>
          setSessionFiles((prev) => [...new Set([...prev, ...names])])
        }
        speakReplies={speakReplies}
        onToggleSpeak={() => {
          if (speakReplies) stopSpeaking();
          setSpeakReplies((on) => !on);
        }}
      />
    </div>
  );
}
