import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StatusBar } from "@/components/StatusBar";
import { Message } from "@/components/Message";
import { Composer } from "@/components/Composer";
import { EmptyState } from "@/components/EmptyState";
import { streamTurn } from "@/lib/agent";
import { appendMention, attachedFiles, enableDesktopControl, fetchCapabilities } from "@/lib/capabilities";
import { FilesDialog } from "@/components/FilesDialog";
import { FileViewer } from "@/components/FileViewer";
import {
  attachToConversation,
  conversationAttachments,
  conversationMessages,
  createConversation,
  detachFromConversation,
  listConversations,
  pendingPlans,
} from "@/lib/conversations";
import { HistoryDialog } from "@/components/HistoryDialog";
import { ProjectsDialog } from "@/components/ProjectsDialog";
import { PipelinesDialog } from "@/components/PipelinesDialog";
import { ConnectionsDialog } from "@/components/ConnectionsDialog";
import { CanvasPanel } from "@/components/CanvasPanel";
import { BootScreen } from "@/components/BootScreen";
import { startMeetingRecorder } from "@/lib/meeting-recorder";
import {
  cancelMeeting,
  meetingState as fetchMeetingState,
  sendSegment,
  startMeeting as startMeetingApi,
  stopMeeting as stopMeetingApi,
} from "@/lib/meetings";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import {
  attachToProject,
  closeProject as closeProjectApi,
  currentProject,
  openProject as openProjectApi,
  projectState,
} from "@/lib/projects";
import { PermissionNotice } from "@/components/PermissionNotice";
import { currentModel } from "@/lib/recipes";
import { MemoryDialog } from "@/components/MemoryDialog";
import { NotesDialog } from "@/components/NotesDialog";
import { SkillsDialog } from "@/components/SkillsDialog";
import { speak, stopSpeaking, takeSentences, warmVoice } from "@/lib/speech";
import { transcribe as transcribeAudio } from "@/lib/dictation";
import { startUtteranceRecorder } from "@/lib/utterance-recorder";
import { createVoiceLoop } from "@/lib/voice-loop";

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
  // The one local model worth escalating to on this machine, or null --
  // computed server-side from the catalogue, bandwidth and current model.
  const [upgrade, setUpgrade] = useState(null);
  // Files attached since startup. capabilities.files is fetched once, so
  // without this a file pasted a moment ago is not recognised as a file --
  // by the composer's chips or by the thread's previews.
  const [sessionFiles, setSessionFiles] = useState([]);
  // Off by default, deliberately. An assistant that starts talking without
  // being asked is startling in a way a silent one never is.
  const [speakReplies, setSpeakReplies] = useState(false);
  // Voice conversation mode: the loop object lives in a ref (it is not
  // render state), the pill shows voiceState, and sendRef/streamingRef let
  // the loop call the CURRENT send — a useCallback over messages — without
  // rebuilding the loop every turn.
  const [voiceState, setVoiceState] = useState(null); // null = mode off
  const voiceLoopRef = useRef(null);
  const sendRef = useRef(null);
  const streamingRef = useRef(false);
  const speakPromiseRef = useRef(Promise.resolve());
  const loopTurnRef = useRef(false);
  const prevSpeakRepliesRef = useRef(false);

  // Defined early and over refs only, so the conversation-switch callbacks
  // below (stable useCallbacks) can capture their first-render instance and
  // still tear down whatever loop exists at call time. A no-op when the
  // mode is off — it must not clobber speakReplies then.
  const teardownVoice = () => {
    if (!voiceLoopRef.current) return;
    voiceLoopRef.current.stop();
    voiceLoopRef.current = null;
    setVoiceState(null);
    setSpeakReplies(prevSpeakRepliesRef.current);
  };
  const teardownVoiceRef = useRef(teardownVoice);
  teardownVoiceRef.current = teardownVoice;
  // Which stored conversation this thread is. Minted before the first message
  // rather than at send: attachments are filed under it, and they happen while
  // the message is still being written. An id with no messages behind it costs
  // one row and never appears in the list.
  const [conversationId, setConversationId] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // The active project, as the server reports it. Null when nothing is open —
  // which is also every fresh boot, since activation is process memory there.
  const [project, setProject] = useState(null);
  // Standing attachments scoped to the open conversation — loaded whenever
  // the conversation changes, so restore and history switches carry them.
  const [convAttachments, setConvAttachments] = useState([]);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  // Meeting capture: server-owned state, poll-shaped like the model
  // download (a meeting outlives any one request). The recorder handle
  // lives in a ref because it is imperative machinery, not render state.
  const [meeting, setMeeting] = useState(null);
  const meetingRecorderRef = useRef(null);
  const meetingHandledRef = useRef(null);
  // The pinned canvas: a file the agent wrote (or the user opened) shown
  // beside the thread. Renderer-session state, like widgets -- a restored
  // conversation does not reopen it. rev bumps when the agent rewrites the
  // pinned path, so the panel knows to reload.
  const [canvas, setCanvas] = useState(null); // {path, openedBy, rev}
  const [attachError, setAttachError] = useState("");
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [pipelinesOpen, setPipelinesOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  // A file opened from the thread. The arrows walk that message's attachments,
  // because those are the ones the question was about.
  const [viewing, setViewing] = useState(null);
  // How full the model's window is, reported by the server after folding.
  const [context, setContext] = useState(null);

  // Saved scripts are AppleScript, so that tab is unfillable off a Mac. Read
  // from the user agent rather than an endpoint because it gates a surface
  // that should not flicker into existence a second after the window opens.
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

  // Re-read after a model switch: the recommendation is relative to what is
  // running, and yesterday's upgrade is today's current model.
  useEffect(() => {
    if (!backendReady) return undefined;
    let live = true;
    const read = () =>
      currentModel()
        .then((m) => {
          if (live) setUpgrade(m.upgrade ?? null);
        })
        .catch(() => {});
    read();
    window.addEventListener("enio:model-switched", read);
    return () => {
      live = false;
      window.removeEventListener("enio:model-switched", read);
    };
  }, [backendReady]);

  // Mirror the open project's roots into the main process, which owns the
  // file affordances (thumbnails, preview, Save as…, Reveal) and otherwise
  // resolves everything against the workspace alone.
  //
  // Capabilities are refetched with it: the file listing *is* project-scoped
  // (its attached folders appear under their aliases), so opening or closing
  // a project without this left the attach menu offering the previous
  // project's files — or none of the new one's.
  useEffect(() => {
    // Project roots first: the main process resolves previews first-match,
    // and the server gives the project the same precedence.
    window.maple?.setProjectRoots?.([
      ...(project?.attachments ?? []),
      ...convAttachments,
    ]);
    if (backendReady) fetchCapabilities().then(setCapabilities);
  }, [project, convAttachments, backendReady]);

  useEffect(() => {
    setAttachError("");
    if (!backendReady || !conversationId) {
      setConvAttachments([]);
      return;
    }
    conversationAttachments(conversationId)
      .then(setConvAttachments)
      .catch(() => setConvAttachments([]));
  }, [conversationId, backendReady]);

  /** Start/stop are USER acts -- the whole meeting pipeline is harness-owned
   *  from here on, which is what makes a model fabricating "I stopped the
   *  recording, here is the summary" structurally impossible. */
  const toggleMeeting = useCallback(async () => {
    if (meetingRecorderRef.current) {
      meetingRecorderRef.current.stop();
      meetingRecorderRef.current = null;
      try {
        setMeeting(await stopMeetingApi());
      } catch (err) {
        setAttachError(String(err?.message ?? err));
      }
      return;
    }
    try {
      const state = await startMeetingApi();
      setMeeting(state);
      meetingHandledRef.current = null;
      meetingRecorderRef.current = await startMeetingRecorder({
        onSegment: (wav, seq) => void sendSegment(wav, seq),
      });
    } catch (err) {
      // getUserMedia refusal or a server 409/503 -- either way the honest
      // move is to tell the server the meeting is off.
      await cancelMeeting().catch(() => {});
      setMeeting(null);
      setAttachError(String(err?.message ?? err));
    }
  }, []);

  // Poll while anything is in flight; on done, open the file in the canvas
  // exactly once (re-polls of a finished state must not re-open it).
  useEffect(() => {
    if (!meeting || ["done", "failed", "cancelled"].includes(meeting.status)) return;
    const timer = setInterval(async () => {
      const state = await fetchMeetingState().catch(() => null);
      if (!state) return;
      setMeeting(state);
      if (state.status === "done" && state.file && meetingHandledRef.current !== state.id) {
        meetingHandledRef.current = state.id;
        setSessionFiles((prev) => [...new Set([...prev, state.file])]);
        setCanvas({ path: state.file, openedBy: "agent", rev: 1 });
      }
      if (state.status === "failed" && meetingHandledRef.current !== state.id) {
        meetingHandledRef.current = state.id;
        setAttachError(`Meeting capture failed: ${state.error ?? "unknown error"}`);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [meeting]);

  /** The attach menu's standing scope: the open project when there is one,
   *  else this conversation. Failures surface verbatim — the server's
   *  refusal prose (caps, unattachable roots) is the explanation. */
  const attachStanding = useCallback(async () => {
    setAttachError("");
    const title = project
      ? "Attach files or folders to this project"
      : "Attach files or folders to this conversation";
    const paths = (await window.maple?.pickProjectPaths?.(title)) ?? [];
    if (paths.length === 0) return;
    // Resolved once, before the loop: creating the conversation triggers the
    // per-conversation effect, whose fetch races any optimistic append -- so
    // the list is re-fetched once at the end instead of appended mid-flight.
    let convId = conversationId;
    if (!project && !convId) {
      convId = await createConversation().catch(() => null);
      if (!convId) return;
      setConversationId(convId);
    }
    for (const p of paths) {
      try {
        if (project) await attachToProject(project.id, p, "");
        else await attachToConversation(convId, p, "");
      } catch (err) {
        setAttachError(String(err?.message ?? err));
      }
    }
    if (project) {
      const state = await projectState().catch(() => null);
      if (state?.project) setProject(state.project);
    } else {
      setConvAttachments(await conversationAttachments(convId).catch(() => []));
    }
  }, [project, conversationId]);

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
    const msgs = transcript.map((m) => ({
      role: m.role,
      content: m.content,
      // Rebuilt server-side from the trace, so a resumed reply keeps the
      // badges and the pages it read rather than arriving as bare text.
      tools: m.tools ?? [],
      agent: m.agent ?? null,
      sources: m.sources ?? [],
      artifacts: m.artifacts ?? [],
      restored: true,
    }));
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
        // Restore the project the user last chose to have OPEN — not one
        // inferred from the newest conversation's tag. Inferring it meant
        // closing a project never survived a relaunch, and every new chat
        // afterwards silently inherited a project nobody had opened.
        const state = await projectState().catch(() => ({}));
        let active = state.project ?? null;
        if (!active && state.lastOpenedId) {
          active = await openProjectApi(state.lastOpenedId)
            .then(() => currentProject())
            .catch(() => null);
        }
        setProject(active);
        if (active?.latestConversation) {
          const msgs = await restoreThread(active.latestConversation);
          setConversationId(active.latestConversation);
          setMessages(msgs);
          return;
        }
        const all = await listConversations();
        if (all.length === 0) {
          // Nothing to resume, but attaching still needs somewhere to file
          // things — so the thread gets its id now rather than on send.
          setConversationId(await createConversation().catch(() => null));
          return;
        }
        // Nothing open: the newest conversation still comes back, but as a
        // transcript only. If it belongs to a project, the history dialog's
        // named badge is the click that re-scopes — consent stays a user act.
        const latest = all[0];
        const msgs = await restoreThread(latest.id);
        setConversationId(latest.id);
        setMessages(msgs);
      } catch {
        /* Fresh chat is the fallback for every failure mode here. */
      }
    })();
    // Deliberately re-runs only when the backend comes up, not on every
    // dependency the body reads — this is boot restore, not a live sync.
  }, [backendReady]);

  const openConversation = useCallback(async (conv) => {
    stopSpeaking();
    teardownVoiceRef.current();
    followRef.current = true;
    setShowJump(false);
    setCanvas(null);
    const msgs = await restoreThread(conv.id).catch(() => []);
    setConversationId(conv.id);
    setMessages(msgs);
  }, [restoreThread]);

  // After opening a project: land in its latest conversation, or a fresh one
  // that the server will tag with it.
  const projectOpened = useCallback(async () => {
    const active = await currentProject().catch(() => null);
    setProject(active);
    setProjectsOpen(false);
    if (active?.latestConversation) {
      stopSpeaking();
    teardownVoiceRef.current();
      const msgs = await restoreThread(active.latestConversation).catch(() => []);
      setConversationId(active.latestConversation);
      setMessages(msgs);
    } else {
      setCanvas(null);
      setMessages([]);
      setContext(null);
      setConversationId(await createConversation().catch(() => null));
    }
  }, [restoreThread]);

  // A fresh conversation inside a project, from the dialog's "Start a
  // conversation" — open (idempotent when already open), then a new tagged
  // chat rather than the resume projectOpened would do.
  const startProjectChat = useCallback(async (projectId) => {
    try {
      await openProjectApi(projectId);
      setProject(await currentProject().catch(() => null));
    } catch {
      return; // could not open: the dialog shows the error state
    }
    setProjectsOpen(false);
    stopSpeaking();
    teardownVoiceRef.current();
    followRef.current = true;
    setShowJump(false);
    setCanvas(null);
    setMessages([]);
    setContext(null);
    setConversationId(await createConversation().catch(() => null));
  }, []);

  // A conversation from another project: the click on "open project" is the
  // consent that re-scopes the sandbox — resuming alone never does.
  const openConversationInProject = useCallback(async (conv) => {
    try {
      await openProjectApi(conv.projectId);
      setProject(await currentProject().catch(() => null));
    } catch {
      /* The conversation still opens; only the scope switch failed. */
    }
    await openConversation(conv);
  }, [openConversation]);

  const newChat = useCallback(async () => {
    stopSpeaking();
    teardownVoiceRef.current();
    followRef.current = true;
    setShowJump(false);
    setCanvas(null);
    setMessages([]);
    setContext(null);
    // Created eagerly so the first turn already has an id to log under. An
    // abandoned empty session never shows in the list — it has no messages.
    setConversationId(await createConversation().catch(() => null));
  }, []);

  const send = useCallback(
    async (text) => {
      let trimmed = text.trim();
      if (!trimmed || streaming || !backendReady) return;

      // Canvas steering, in the open: one visible word. The server resolves
      // @canvas to the pinned file and, unless the message names an agent
      // explicitly, to the agent that can edit it -- so the bubble reads
      // "make it shorter @canvas" rather than a path and an agent name, and
      // a path no mention grammar could express (spaces) still works.
      // Idempotent: send() rewrites from the raw input each time.
      if (canvas && !/(^|\s)@canvas(\s|$)/i.test(trimmed)) {
        trimmed = `${trimmed} @canvas`;
      }

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
      const artifacts = [];
      let agent = null;
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
          canvas?.path ?? null,
        )) {
          if (event.type === "tool") {
            tools.push(event.name);
          } else if (event.type === "route") {
            agent = event.route;
          } else if (event.type === "artifact") {
            for (const item of event.items ?? []) {
              if (!item.path) continue;
              // The chip under the reply: click-to-open for whatever the
              // turn created, document or not.
              if (!artifacts.some((a) => a.path === item.path)) {
                artifacts.push({ type: item.type, path: item.path });
              }
              if (item.type !== "document") continue;
              // Chips + mention resolution for anything the turn wrote,
              // whether or not it opens.
              setSessionFiles((prev) => [...new Set([...prev, item.path])]);
              // Auto-open is documents-only: code files written during
              // project work must not pop panels mid-flow. And a pinned
              // canvas is never stolen -- a second document is reachable
              // through the file viewer.
              if (!/\.(md|txt)$/i.test(item.path)) continue;
              setCanvas((prev) => {
                if (!prev) return { path: item.path, openedBy: "agent", rev: 1 };
                if (prev.path === item.path) return { ...prev, rev: prev.rev + 1 };
                return prev;
              });
            }
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
              // Tracked in a ref: the voice loop's "speaking" state awaits
              // the LAST of these — every speak() joins one drain, so the
              // latest promise covers the whole queue.
              for (const sentence of ready) speakPromiseRef.current = speak(sentence);
            }
          }
          setMessages([
            ...history,
            {
              role: "assistant",
              content: assistant,
              tools: [...tools],
              widgets: [...widgets],
              artifacts: [...artifacts],
              agent,
              sources: sources.map((s) => ({ ...s })),
              thinking,
              notices: [...notices],
              startedAt,
            },
          ]);
        }

        // Whatever is left over: a final clause with no full stop, or a reply
        // short enough that no sentence ever completed mid-stream.
        if (speakReplies && unspoken.trim()) speakPromiseRef.current = speak(unspoken);
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
    [backendReady, canvas, capabilities, conversationId, messages, sessionFiles, speakReplies, streaming],
  );

  // Only when the handoff skill is actually installed: a button that sends
  // "/ask-bigger-model" into a system without the skill produces a model
  // staring at an unparsed slash command.
  //
  // The last real question rides along VERBATIM. Told only "package what I
  // was trying to do above", a 4B in a restored thread packaged a task from
  // its memory block instead of the conversation — background about the
  // user mistaken for the task. Quoting the question puts the target in the
  // message itself: selection, not judgement. Mention sigils are stripped
  // from the quote so it cannot re-steer the turn it rides in.
  const askBigger = (capabilities.abilities ?? []).some(
    (a) => a.id === "ask-bigger-model" && a.availability === "available",
  )
    ? () => {
        const lastQuestion = [...messages]
          .reverse()
          .find((m) => m.role === "user" && !/^\/ask-bigger-model/.test(m.content ?? ""))
          ?.content?.replace(/[@/]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 240);
        send(
          "/ask-bigger-model @coder The answer was not enough. Package this task " +
            `into a handoff prompt for a bigger model${lastQuestion ? `: "${lastQuestion}"` : "."}`,
        );
      }
    : undefined;

  const tryUpgrade = upgrade
    ? () =>
        window.dispatchEvent(
          new CustomEvent("enio:browse-models", { detail: { highlight: upgrade.id } }),
        )
    : undefined;

  // --- voice conversation mode -------------------------------------------
  sendRef.current = send;
  streamingRef.current = streaming;

  // A turn the loop did NOT start (the user typed) must hold the mic: with
  // speech forced on, the reply will be spoken, and half-duplex means the
  // recorder cannot be listening while that happens.
  useEffect(() => {
    voiceLoopRef.current?.setHeld(streaming && !loopTurnRef.current);
  }, [streaming]);

  const enterVoiceMode = useCallback(async () => {
    if (voiceLoopRef.current) return;
    warmVoice(); // Kokoro's cold load is ~4.5s; pay it now, not mid-reply
    prevSpeakRepliesRef.current = speakReplies;
    setSpeakReplies(true);
    const loop = createVoiceLoop({
      startRecorder: startUtteranceRecorder,
      transcribe: (wav) => transcribeAudio(wav), // accurate pass, never fast
      sendTurn: async (text) => {
        loopTurnRef.current = true;
        try {
          await sendRef.current(text);
        } finally {
          loopTurnRef.current = false;
        }
      },
      speakDone: () => speakPromiseRef.current,
      isBusy: () => streamingRef.current,
      // The two independent primitives, fired together — an aborted spoken
      // reply must also stop being spoken.
      interruptTurn: () => {
        abortRef.current?.abort();
        stopSpeaking();
      },
      onState: setVoiceState,
      // Never swallowed: a transcription that 500s or a microphone that
      // disappears leaves the pill cycling back to "listening" with no sign
      // anything went wrong, which reads as enio ignoring you.
      onError: (err) => setAttachError(`Voice: ${String(err?.message ?? err)}`),
    });
    voiceLoopRef.current = loop;
    await loop.start();
    if (loop.state === "idle") {
      // getUserMedia refused — mode never opened.
      voiceLoopRef.current = null;
      setVoiceState(null);
      setSpeakReplies(prevSpeakRepliesRef.current);
    }
  }, [speakReplies]);

  return (
    <TooltipProvider delayDuration={300}>
    <div className="flex h-screen flex-col bg-background">
      <StatusBar
        {...status}
        context={context}
        onNewChat={newChat}
        project={project}
        onProjects={() => setProjectsOpen(true)}
        onCloseProject={async () => {
          // Only the session's scope ends; the project and its files stay.
          await closeProjectApi().catch(() => {});
          setProject(null);
        }}
        onHistory={() => setHistoryOpen(true)}
        onPipelines={() => setPipelinesOpen(true)}
        onMemory={() => setMemoryOpen(true)}
        onNotes={() => setNotesOpen(true)}
        meeting={meeting}
        onToggleMeeting={capabilities.voice?.transcription ? toggleMeeting : undefined}
        onSkills={() => setSkillsOpen(true)}
        onFiles={() => setFilesOpen(true)}
      />

      <SkillsDialog
        open={skillsOpen}
        onOpenChange={setSkillsOpen}
        onEdit={(name) => {
          // Same gesture as opening a note: the panel hands the document to
          // the canvas and gets out of the way. ".skill/" is a handle, not a
          // workspace path — the panel resolves it over the API.
          setSkillsOpen(false);
          setCanvas({ path: `.skill/${name}`, openedBy: "user", rev: Date.now(), full: true });
        }}
      />

      <PipelinesDialog
        open={pipelinesOpen}
        onOpenChange={setPipelinesOpen}
        abilities={capabilities.abilities ?? []}
        showRecipes={isMac}
      />
      <MemoryDialog open={memoryOpen} onOpenChange={setMemoryOpen} />
      <NotesDialog
        open={notesOpen}
        onOpenChange={setNotesOpen}
        onOpen={(path) =>
          // Fullscreen by default: opening from this panel is choosing the
          // document, note or meeting alike. The header toggle brings chat
          // back. The dialog passes full relative paths, .notes/ included.
          setCanvas({ path, openedBy: "user", rev: Date.now(), full: true })
        }
      />
      <ConnectionsDialog
        open={connectionsOpen}
        onOpenChange={(open) => {
          setConnectionsOpen(open);
          // Refetch on close, not only on in-app changes: the same file is
          // editable from the CLI and the API, and the mention menu reads
          // the cached capabilities.
          if (!open) fetchCapabilities().then(setCapabilities);
        }}
        onChanged={() => fetchCapabilities().then(setCapabilities)}
      />

      <ProjectsDialog
        open={projectsOpen}
        onOpenChange={setProjectsOpen}
        activeId={project?.id}
        onOpened={projectOpened}
        onClosed={() => setProject(null)}
        onStartChat={startProjectChat}
      />

      {viewing && (
        <FileViewer
          open
          files={viewing.files}
          index={viewing.index}
          onIndex={(index) => setViewing((v) => ({ ...v, index }))}
          onOpenChange={(next) => !next && setViewing(null)}
          onEdit={(p) => {
            setCanvas({ path: p, openedBy: "user", rev: 1 });
            setViewing(null);
          }}
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
        activeProjectId={project?.id}
        onPick={openConversation}
        onOpenProject={openConversationInProject}
        onDiscarded={(id) => {
          // Discarding took its attachments with it, so this thread cannot
          // keep the id — the folder it was filing into is gone.
          if (id === conversationId) newChat();
        }}
      />

      {/* Split view: the whole thread+composer run becomes the left panel
          when a canvas is pinned. Resizable, and the split remembers where
          you left it (autoSaveId persists to localStorage). Nothing inside
          the left column changes shape or order. */}
      {/* Keyed on the mode: remounting the group is what lets a lone canvas
          panel normalize to the full width, and keeps the saved split layout
          from absorbing a one-panel arrangement. */}
      <ResizablePanelGroup
        key={canvas?.full ? "canvas-full" : "canvas-split"}
        direction="horizontal"
        autoSaveId={canvas?.full ? undefined : "canvas-split"}
        className="min-h-0 flex-1"
      >
      {!canvas?.full && (
      <ResizablePanel defaultSize={58} minSize={35} className="flex min-w-0 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col">
      <main ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
        {!backendReady ? (
          // Booting used to render the launcher greyed and silent -- which
          // reads as broken, not busy. The main process narrates each phase;
          // this is where that narration belongs.
          <BootScreen status={status} />
        ) : messages.length === 0 ? (
          // Tiles prefill and hand over the caret; the user finishes the
          // sentence, so the turn is theirs. The old wiring sent immediately.
          <EmptyState
            abilities={capabilities.abilities ?? []}
            onPrefill={(text) => {
              setInput(text);
              composerRef.current?.focus?.();
            }}
            onOpenPipelines={() => setPipelinesOpen(true)}
            onRecordMeeting={capabilities.voice?.transcription ? toggleMeeting : undefined}
            onOpenNotes={() => setNotesOpen(true)}
            onEnableDesktop={async () => {
              await enableDesktopControl();
              // The registry just changed shape; the tiles follow it.
              setCapabilities(await fetchCapabilities());
            }}
            disabled={!backendReady}
          />
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
                  onOpenArtifact={(path) => setCanvas({ path, openedBy: "user", rev: 1 })}
                  onAskBigger={askBigger}
                  upgrade={upgrade}
                  onTryUpgrade={tryUpgrade}
                  speakDisabled={!!voiceState}
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

      {attachError && (
        <p className="shrink-0 px-4 pb-1 text-xs text-destructive">{attachError}</p>
      )}
      {/* Standing conversation attachments: present for the whole thread, so
          they live above the composer rather than inside one message. */}
      {!project && convAttachments.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pb-1.5">
          {convAttachments.map((a) => (
            <span
              key={a.alias}
              title={a.path}
              className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-[11px]"
            >
              <span className="font-mono">{a.alias}{a.kind === "folder" ? "/" : ""}</span>
              <button
                className="text-muted-foreground hover:text-destructive"
                title="Detach from this conversation"
                onClick={async () => {
                  await detachFromConversation(conversationId, a.alias).catch(() => {});
                  setConvAttachments((prev) => prev.filter((x) => x.alias !== a.alias));
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

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
        conversationAttachments={convAttachments}
        placeholder={
          canvas
            ? canvas.path.startsWith(".notes/")
              ? `Editing note "${canvas.path.split("/").pop().replace(/\.md$/, "")}" — describe a change`
              : `Editing ${canvas.path.split("/").pop()} — describe a change`
            : undefined
        }
        onAttachStanding={attachStanding}
        onManageConnections={() => setConnectionsOpen(true)}
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
        voiceState={voiceState}
        onToggleVoice={() => (voiceLoopRef.current ? teardownVoiceRef.current() : enterVoiceMode())}
        onVoiceInterrupt={() => voiceLoopRef.current?.interrupt()}
      />
      </ResizablePanel>
      )}

      {canvas && (
        <>
          {!canvas.full && <ResizableHandle withHandle />}
          <ResizablePanel
            defaultSize={canvas.full ? 100 : 42}
            minSize={canvas.full ? 100 : 22}
            maxSize={canvas.full ? 100 : 60}
          >
            <CanvasPanel
              path={canvas.path}
              rev={canvas.rev}
              full={!!canvas.full}
              onToggleFull={() => setCanvas((c) => (c ? { ...c, full: !c.full } : c))}
              onClose={() => setCanvas(null)}
              onDiscarded={() => setCanvas(null)}
              className="h-full"
            />
          </ResizablePanel>
        </>
      )}
      </ResizablePanelGroup>
    </div>
    </TooltipProvider>
  );
}
