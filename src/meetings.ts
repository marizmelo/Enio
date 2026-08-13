import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { unsupportedSpecifics } from "./grounding.js";
import { chunkTranscript } from "./memory/extract.js";
import { endSession, indexPending, logMessage, startSession } from "./memory/store.js";
import { contextBudget } from "./model-settings.js";
import { complete } from "./model.js";
import { safePath } from "./tools/fs.js";
import { transcribeWav, whisperInstalled } from "./voice.js";

/**
 * Meeting capture: record → local transcript → grounded summary → memory.
 *
 * The HARNESS owns this lifecycle end to end. The design it replaces — tools
 * the model calls to start and stop recording — failed in a documented,
 * instructive way: a small model asked to "record AND summarise afterwards"
 * called stop_recording and then fabricated a complete summary of a meeting
 * that had not happened, because a model this size does not understand
 * temporality. Start and stop are user acts in the UI; everything between
 * them is deterministic code; the model's only role is turning a transcript
 * that actually exists into notes.
 *
 * Audio arrives as ~45-second WAV segments rather than one recording, and
 * that one choice answers three constraints at once: the renderer's heap
 * (Float32 accumulation is ~11.5MB/min — segments flush it), Node's request
 * timeout (an hour of WAV is ~115MB in one body), and the whisper worker's
 * strictly serial FIFO (a segment transcribes in seconds, so dictation
 * queued behind a meeting never starves).
 *
 * The silence trap is closed structurally, not by prompt: below a transcript
 * threshold there is NO summary model call at all — Whisper famously turns
 * an hour of room tone into noise tokens, and a model will confidently
 * summarise noise into decisions nobody made.
 *
 * Module state, deliberately not persisted (the model-download rule): after
 * a crash, claiming a recording is still running would be a lie the UI acts
 * on. Segments on disk from a dead run are purged by age instead.
 */

export interface MeetingState {
  id: string;
  status: "recording" | "transcribing" | "summarizing" | "done" | "failed" | "cancelled";
  topic?: string;
  startedAt: number;
  /** Segments received / segments transcribed — the UI's sign of life. */
  segments: number;
  transcribed: number;
  transcriptChars: number;
  /** The written file, addressable the way every tool prints paths. */
  file?: string;
  error?: string;
}

export class MeetingRefused extends Error {}

export interface MeetingDeps {
  /** Injected in tests: the whisper venv does not exist in CI. */
  transcribe?: typeof transcribeWav;
  /** Watchdog idle window; tiny in tests. */
  staleMs?: number;
  /** Availability probe, injectable for the same CI reason. */
  installed?: () => boolean;
}

interface ActiveMeeting extends MeetingState {
  dir: string;
  parts: Map<number, string>;
  queue: Promise<void>;
  deps: Required<Pick<MeetingDeps, "transcribe" | "staleMs" | "installed">>;
  lastSegmentAt: number;
  watchdog?: ReturnType<typeof setInterval>;
}

let current: ActiveMeeting | null = null;

const SILENCE_THRESHOLD_CHARS = 200;
const PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function meetingState(): MeetingState | null {
  if (!current) return null;
  const { dir, parts, queue, deps, lastSegmentAt, watchdog, ...state } = current;
  void dir; void parts; void queue; void deps; void lastSegmentAt; void watchdog;
  return { ...state };
}

function meetingsRoot(): string {
  return join(config.dataDir, "meetings");
}

/** Orphans from a killed server say nothing useful after a week. */
function purgeOld(): void {
  try {
    const root = meetingsRoot();
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      try {
        if (Date.now() - statSync(dir).mtimeMs > PURGE_AFTER_MS) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        /* a vanished entry is already what purging wanted */
      }
    }
  } catch {
    /* purging is a nicety; recording must not fail because of it */
  }
}

export function startMeeting(topic?: string, deps: MeetingDeps = {}): MeetingState {
  const installed = deps.installed ?? whisperInstalled;
  if (!installed()) {
    throw new MeetingRefused(
      "Speech recognition is not installed. Run: enio voice --install",
    );
  }
  if (current && ["recording", "transcribing", "summarizing"].includes(current.status)) {
    throw new MeetingRefused("A meeting is already being recorded. Stop it first.");
  }
  purgeOld();

  const id = randomUUID();
  const dir = join(meetingsRoot(), id);
  mkdirSync(dir, { recursive: true });

  current = {
    id,
    status: "recording",
    ...(topic?.trim() ? { topic: topic.trim() } : {}),
    startedAt: Date.now(),
    segments: 0,
    transcribed: 0,
    transcriptChars: 0,
    dir,
    parts: new Map(),
    queue: Promise.resolve(),
    deps: {
      transcribe: deps.transcribe ?? transcribeWav,
      staleMs: deps.staleMs ?? 90_000,
      installed,
    },
    lastSegmentAt: Date.now(),
  };

  // The watchdog is what makes a dead renderer honest: if segments stop
  // arriving and no stop ever comes, finalize with what exists. A truncated
  // real file beats a state stuck on "recording" forever.
  const meeting = current;
  meeting.watchdog = setInterval(() => {
    if (meeting !== current || meeting.status !== "recording") {
      clearInterval(meeting.watchdog);
      return;
    }
    if (Date.now() - meeting.lastSegmentAt > meeting.deps.staleMs) {
      clearInterval(meeting.watchdog);
      void finalize(meeting, { note: "Recording ended unexpectedly." });
    }
  }, Math.max(1000, Math.min(meeting.deps.staleMs, 15_000)));
  meeting.watchdog.unref?.();

  return meetingState()!;
}

export function addSegment(wav: Buffer, seq: number): MeetingState {
  const meeting = current;
  if (!meeting || meeting.status !== "recording") {
    throw new MeetingRefused("No meeting is being recorded.");
  }
  meeting.lastSegmentAt = Date.now();
  meeting.segments++;

  const file = join(meeting.dir, `seg-${seq}.wav`);
  writeFileSync(file, wav);

  // A promise chain, not Promise.all: the whisper worker is a serial FIFO,
  // and ordering here keeps a meeting's segments contiguous in its queue.
  meeting.queue = meeting.queue.then(async () => {
    // A cancelled or superseded meeting ignores late results rather than
    // aborting the worker call -- the FIFO's order-matched responses mean an
    // abandoned slot would desync every caller after us.
    if (meeting !== current && meeting.status === "cancelled") return;
    try {
      const result = await meeting.deps.transcribe(file);
      if (meeting.status === "cancelled") return;
      meeting.parts.set(seq, result.text ?? "");
      meeting.transcribed++;
      meeting.transcriptChars += (result.text ?? "").length;
      if (!result.error) rmSync(file, { force: true });
      // Errored segments keep their WAV inside the meeting dir for manual
      // retry; the age purge collects them eventually.
    } catch {
      meeting.parts.set(seq, "");
      meeting.transcribed++;
    }
  });

  return meetingState()!;
}

export function stopMeeting(): MeetingState {
  const meeting = current;
  if (!meeting || meeting.status !== "recording") {
    throw new MeetingRefused("No meeting is being recorded.");
  }
  clearInterval(meeting.watchdog);
  void finalize(meeting, {});
  return meetingState()!;
}

export function cancelMeeting(): boolean {
  const meeting = current;
  if (!meeting || ["done", "failed", "cancelled"].includes(meeting.status)) return false;
  clearInterval(meeting.watchdog);
  meeting.status = "cancelled";
  rmSync(meeting.dir, { recursive: true, force: true });
  return true;
}

/* ---------------------------------------------------------------- finalize */

async function finalize(meeting: ActiveMeeting, opts: { note?: string }): Promise<void> {
  if (meeting.status !== "recording") return;
  meeting.status = "transcribing";
  try {
    await meeting.queue;
    if ((meeting.status as string) === "cancelled") return;

    // Join by sequence; a gap is said out loud rather than spliced over --
    // "the recording is missing a piece here" is information the summary
    // reader needs, and silent splicing would misattribute what follows.
    const seqs = [...meeting.parts.keys()].sort((a, b) => a - b);
    const pieces: string[] = [];
    let expected = seqs.length > 0 ? seqs[0]! : 0;
    for (const seq of seqs) {
      while (seq > expected) {
        pieces.push("[audio missing]");
        expected++;
      }
      const text = meeting.parts.get(seq)!.trim();
      if (text) pieces.push(text);
      expected = seq + 1;
    }
    const transcript = pieces.join("\n");

    const stamp = new Date(meeting.startedAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateLine = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`;
    const baseName = `meeting-${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;

    const header =
      `# Meeting — ${dateLine}\n` +
      (meeting.topic ? `\nTopic: ${meeting.topic}\n` : "") +
      (opts.note ? `\n> ${opts.note}\n` : "");

    let body: string;
    if (transcript.length < SILENCE_THRESHOLD_CHARS) {
      // The trap this whole module exists to avoid: Whisper turns silence
      // into noise tokens, and a small model will summarise noise into
      // decisions nobody made. Below the threshold NO model call happens --
      // but silence and short-but-real are different truths: a live probe
      // produced a perfect 114-char transcript under a header claiming
      // nothing intelligible was recorded, which was a lie about good data.
      if (transcript.trim()) {
        body = `${header}\nToo short to summarize — the transcript is complete below.\n`;
        body += `\n## Transcript\n\n${transcript}\n`;
      } else {
        body = `${header}\nNothing intelligible was recorded.\n`;
      }
    } else {
      meeting.status = "summarizing";
      const sections = await summarizeMeeting(transcript);
      if ((meeting.status as string) === "cancelled") return;

      // Grounding, appended rather than rewritten: a second generation pass
      // to "fix" the summary is the open-ended step being avoided. The
      // flagged specifics are listed for the reader to check.
      const summaryText = [sections.summary, sections.decisions, sections.actions, sections.questions]
        .filter(Boolean)
        .join("\n");
      const invented = unsupportedSpecifics(summaryText, [transcript]);

      body = header + "\n";
      if (sections.summary) body += `## Summary\n\n${sections.summary}\n\n`;
      if (sections.decisions) body += `## Decisions\n\n${sections.decisions}\n\n`;
      if (sections.actions) body += `## Action items\n\n${sections.actions}\n\n`;
      if (sections.questions) body += `## Open questions\n\n${sections.questions}\n\n`;
      if (invented.length > 0) {
        body +=
          `## Verify (not found in transcript)\n\n` +
          invented.map((i) => `- ${i}`).join("\n") +
          "\n\n";
      }
      body += `## Transcript\n\n${transcript}\n`;
    }

    // Resolved at write time so an open project catches the file in its own
    // out/ folder, exactly like every other generated document.
    let rel = `${baseName}.md`;
    let target = safePath(rel);
    for (let n = 2; existsSync(target); n++) {
      rel = `${baseName}-${n}.md`;
      target = safePath(rel);
    }
    await writeFile(target, body, "utf8");
    meeting.file = rel;

    rmSync(meeting.dir, { recursive: true, force: true });
    // Done the moment the file exists: the user's meeting is finished and
    // the canvas can open. Indexing is a background chore -- awaiting it
    // held the "done" status hostage to every OTHER un-indexed session
    // indexPending() sweeps up, observed live as minutes of "summarizing"
    // after the file was already on disk.
    meeting.status = "done";

    // Into memory the same way every conversation goes: a session that
    // indexPending() summarises, embeds and mines for the knowledge graph.
    if (transcript.length >= SILENCE_THRESHOLD_CHARS) {
      const sessionId = startSession();
      logMessage(sessionId, "user", `Meeting transcript (${dateLine}):\n${transcript}`);
      logMessage(sessionId, "assistant", body);
      endSession(sessionId);
      void indexPending().catch(() => {
        // The next indexPending() sweep picks the session up; losing a
        // background index run must not mark a finished meeting failed.
      });
    }
  } catch (err) {
    if ((meeting.status as string) !== "cancelled") {
      meeting.status = "failed";
      meeting.error = (err as Error).message;
    }
  }
}

/* --------------------------------------------------------------- summarize */

export interface MeetingSections {
  summary?: string;
  decisions?: string;
  actions?: string;
  questions?: string;
}

const NOTES_PROMPT =
  `These are raw notes from part of a meeting transcript. Rewrite them as ` +
  `terse minutes: keep names, numbers, dates and decisions VERBATIM from the ` +
  `text; drop filler. Output only the minutes, no preamble.`;

const SECTION_PROMPTS: Array<{ key: keyof MeetingSections; prompt: string }> = [
  {
    key: "summary",
    prompt:
      `Summarise this meeting in 2-4 sentences of plain prose from the notes ` +
      `below. Only state what appears in the notes. No preamble.`,
  },
  {
    key: "decisions",
    prompt:
      `List the decisions made in this meeting, one per line prefixed "- ", ` +
      `using only what appears in the notes below. If no decisions appear, ` +
      `output exactly: none`,
  },
  {
    key: "actions",
    prompt:
      `List the action items from this meeting, one per line prefixed "- ", ` +
      `with the owner when named, using only what appears in the notes below. ` +
      `If none appear, output exactly: none`,
  },
  {
    key: "questions",
    prompt:
      `List the questions left open in this meeting, one per line prefixed ` +
      `"- ", using only what appears in the notes below. If none appear, ` +
      `output exactly: none`,
  },
];

/**
 * Map, then one call per section — never one open "write the minutes" pass.
 *
 * A transcript outruns the context budget (an hour is 12-15k tokens against
 * qwen3's 12k), so the map pass compresses chunk by chunk. The reduce is
 * split per section because "list only what appears, else say none" is
 * classification-shaped — the thing this model size does well — where one
 * combined generation pass is exactly where it pads and invents.
 */
export async function summarizeMeeting(transcript: string): Promise<MeetingSections> {
  const chunks = chunkTranscript(transcript, 2500);
  const notes: string[] = [];
  for (const chunk of chunks) {
    const result = await complete(
      [
        { role: "system", content: NOTES_PROMPT },
        { role: "user", content: chunk },
      ],
      [],
      {},
      undefined,
      { temperature: 0 },
    );
    notes.push(result.content.trim());
  }

  // Very long meetings: fold pairs of notes once so the section calls fit
  // even Maple's 2000-token budget. One fold, not a loop — a second fold
  // would be summarising a summary of a summary.
  let joined = notes.join("\n\n");
  const cap = contextBudget() * 3;
  if (joined.length > cap && notes.length > 1) {
    const folded: string[] = [];
    for (let i = 0; i < notes.length; i += 2) {
      const pair = notes.slice(i, i + 2).join("\n\n");
      if (pair.length < 1500) {
        folded.push(pair);
        continue;
      }
      const result = await complete(
        [
          { role: "system", content: NOTES_PROMPT },
          { role: "user", content: pair },
        ],
        [],
        {},
        undefined,
        { temperature: 0 },
      );
      folded.push(result.content.trim());
    }
    joined = folded.join("\n\n");
  }

  const sections: MeetingSections = {};
  for (const { key, prompt } of SECTION_PROMPTS) {
    const result = await complete(
      [
        { role: "system", content: prompt },
        { role: "user", content: joined },
      ],
      [],
      {},
      undefined,
      { temperature: 0 },
    );
    const text = result.content.trim();
    if (text && !/^none[.!]?$/i.test(text)) sections[key] = text;
  }
  return sections;
}
