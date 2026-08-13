import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "enio-meetings-"));
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-such-mcp.json");
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

const meetings = await import("./meetings.js");
const { getDb, closeDb } = await import("./memory/db.js");

const originalFetch = globalThis.fetch;

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test owns the module state: cancel whatever the previous one left.
  meetings.cancelMeeting();
  globalThis.fetch = originalFetch;
});

/** A transcriber whose per-segment text is scripted by seq. */
const fakeTranscriber = (texts: Record<number, string>, delayMs = 0) => {
  return async (path: string) => {
    const seq = Number(/seg-(\d+)\.wav/.exec(path)?.[1] ?? -1);
    if (delayMs) {
      // Randomized inside the bound, so ordering bugs surface as flakes here
      // rather than as production behavior.
      await new Promise((r) => setTimeout(r, Math.random() * delayMs));
    }
    return { text: texts[seq] ?? "" };
  };
};

/** Scripted SSE model, the integration.test.ts idiom, keyed by call order. */
function scriptModel(replies: string[]) {
  const queue = [...replies];
  globalThis.fetch = (async () => {
    const content = queue.shift() ?? "(exhausted)";
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    return new Response(frames.join(""), { status: 200 });
  }) as typeof fetch;
}

const installed = () => true;
const wav = Buffer.alloc(100);

async function finished() {
  // finalize is async fire-and-forget; poll the state like the client does.
  for (let i = 0; i < 200; i++) {
    const state = meetings.meetingState();
    if (!state || ["done", "failed", "cancelled"].includes(state.status)) return state;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`never finished: ${JSON.stringify(meetings.meetingState())}`);
}

test("a second start is refused while one is active", () => {
  meetings.startMeeting("standup", { transcribe: fakeTranscriber({}), installed });
  assert.throws(() => meetings.startMeeting(undefined, { installed }), meetings.MeetingRefused);
  meetings.cancelMeeting();
});

test("whisper missing refuses with the install hint", () => {
  assert.throws(
    () => meetings.startMeeting(undefined, { installed: () => false }),
    /enio voice --install/,
  );
});

test("segments join in sequence order despite unordered completion", async () => {
  const line = "a decision was made to ship the release on Friday, said Dana. ";
  const texts = { 0: line.repeat(3) + "ZERO", 1: line.repeat(3) + "ONE", 2: line.repeat(3) + "TWO" };
  meetings.startMeeting(undefined, { transcribe: fakeTranscriber(texts, 25), installed });
  meetings.addSegment(wav, 0);
  meetings.addSegment(wav, 1);
  meetings.addSegment(wav, 2);
  scriptModel(["notes", "summary text", "none", "none", "none"]);
  meetings.stopMeeting();
  const state = await finished();
  assert.equal(state!.status, "done");
  const body = readFileSync(join(process.env.ENIO_WORKSPACE!, state!.file!), "utf8");
  const zero = body.indexOf("ZERO");
  const one = body.indexOf("ONE");
  const two = body.indexOf("TWO");
  assert.ok(zero > -1 && one > zero && two > one, "transcript in seq order");
});

test("a missing sequence number is said out loud, not spliced over", async () => {
  const filler = "we agreed the budget review moves to Thursday afternoon this quarter. ";
  meetings.startMeeting(undefined, {
    transcribe: fakeTranscriber({ 0: filler.repeat(3), 2: filler.repeat(3) }),
    installed,
  });
  meetings.addSegment(wav, 0);
  meetings.addSegment(wav, 2); // seq 1 never arrives
  scriptModel(["notes", "summary", "none", "none", "none"]);
  meetings.stopMeeting();
  const state = await finished();
  const body = readFileSync(join(process.env.ENIO_WORKSPACE!, state!.file!), "utf8");
  assert.match(body, /\[audio missing\]/);
});

test("silence writes an honest file and makes ZERO model calls", async () => {
  meetings.startMeeting(undefined, { transcribe: fakeTranscriber({ 0: "" }), installed });
  meetings.addSegment(wav, 0);
  // Any model call would throw loudly — the assertion is structural.
  globalThis.fetch = (async () => {
    throw new Error("the silence path must not call the model");
  }) as typeof fetch;
  meetings.stopMeeting();
  const state = await finished();
  assert.equal(state!.status, "done");
  const body = readFileSync(join(process.env.ENIO_WORKSPACE!, state!.file!), "utf8");
  assert.match(body, /Nothing intelligible was recorded/);
});

test("short-but-real speech keeps its transcript and is not called silence", async () => {
  // Found live: a perfect 114-char transcript sat under "Nothing
  // intelligible was recorded". Silence and too-short are different truths.
  meetings.startMeeting(undefined, {
    transcribe: fakeTranscriber({ 0: "Ship the beta Friday. Sarah writes the notes." }),
    installed,
  });
  meetings.addSegment(wav, 0);
  globalThis.fetch = (async () => {
    throw new Error("short transcripts must not be summarized either");
  }) as typeof fetch;
  meetings.stopMeeting();
  const state = await finished();
  const body = readFileSync(join(process.env.ENIO_WORKSPACE!, state!.file!), "utf8");
  assert.match(body, /Too short to summarize/);
  assert.match(body, /Sarah writes the notes/);
  assert.ok(!body.includes("Nothing intelligible"), "good data is not called silence");
});

test("sections come from the harness; 'none' sections are omitted", async () => {
  const talk = "Rivka said the launch is approved for September and Marco owns the deck. ";
  meetings.startMeeting("launch sync", {
    transcribe: fakeTranscriber({ 0: talk.repeat(5) }),
    installed,
  });
  meetings.addSegment(wav, 0);
  scriptModel([
    "Rivka approved the September launch; Marco owns the deck.", // map notes
    "The team approved the September launch and assigned the deck to Marco.", // summary
    "- Launch approved for September", // decisions
    "- Marco: prepare the deck", // actions
    "none", // open questions
  ]);
  meetings.stopMeeting();
  const state = await finished();
  assert.equal(state!.status, "done");
  const body = readFileSync(join(process.env.ENIO_WORKSPACE!, state!.file!), "utf8");
  assert.match(body, /## Summary/);
  assert.match(body, /## Decisions/);
  assert.match(body, /## Action items/);
  assert.ok(!body.includes("## Open questions"), "'none' section omitted");
  assert.match(body, /Topic: launch sync/);
  assert.match(body, /## Transcript/);
});

test("an invented specific lands in the Verify section, untouched in the summary", async () => {
  const talk = "The group discussed migrating the internal wiki to the new platform soon. ";
  meetings.startMeeting(undefined, {
    transcribe: fakeTranscriber({ 0: talk.repeat(5) }),
    installed,
  });
  meetings.addSegment(wav, 0);
  scriptModel([
    "Discussed migrating the wiki.", // notes
    "The wiki migration was discussed; contact rivka@example.com to proceed.", // summary WITH invented email
    "none",
    "none",
    "none",
  ]);
  meetings.stopMeeting();
  const state = await finished();
  const body = readFileSync(join(process.env.ENIO_WORKSPACE!, state!.file!), "utf8");
  assert.match(body, /## Verify \(not found in transcript\)/);
  assert.match(body, /- rivka@example\.com/);
  // The summary itself was not rewritten.
  assert.match(body, /contact rivka@example\.com to proceed/);
});

test("cancel discards the scratch dir and late transcriptions are ignored", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  meetings.startMeeting(undefined, {
    transcribe: async () => {
      await gate;
      return { text: "too late" };
    },
    installed,
  });
  const state = meetings.meetingState()!;
  const dir = join(process.env.ENIO_DATA_DIR!, "meetings", state.id);
  meetings.addSegment(wav, 0);
  assert.ok(existsSync(dir));
  assert.equal(meetings.cancelMeeting(), true);
  assert.ok(!existsSync(dir), "scratch dir discarded");
  release();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(meetings.meetingState()!.status, "cancelled");
});

test("the meeting is indexed into memory as an ordinary session", async () => {
  const talk = "Priya confirmed the audit finishes next week and Tom writes the report. ";
  meetings.startMeeting(undefined, {
    transcribe: fakeTranscriber({ 0: talk.repeat(5) }),
    installed,
  });
  meetings.addSegment(wav, 0);
  // map notes, summary, decisions, actions, questions, then indexPending's
  // own summarize + triple extraction calls ride the same scripted fetch.
  scriptModel([
    "Priya: audit done next week; Tom writes report.",
    "The audit finishes next week; Tom writes the report.",
    "none",
    "- Tom: write the audit report",
    "none",
    "Audit wrap-up meeting: audit finishes next week, Tom writes the report.",
    "[]",
  ]);
  meetings.stopMeeting();
  const state = await finished();
  assert.equal(state!.status, "done");
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE content LIKE 'Meeting transcript%'`,
    )
    .get() as { n: number };
  assert.ok(row.n >= 1, "transcript logged as a session message");
});

test("the watchdog finalizes an abandoned recording", async () => {
  const talk = "The retrospective covered the deployment incident and its follow-ups fully. ";
  meetings.startMeeting(undefined, {
    transcribe: fakeTranscriber({ 0: talk.repeat(5) }),
    installed,
    staleMs: 60,
  });
  meetings.addSegment(wav, 0);
  scriptModel(["notes", "summary", "none", "none", "none"]);
  // No stop call: the renderer died. The watchdog must finish the job.
  const state = await finished();
  assert.equal(state!.status, "done");
  const body = readFileSync(join(process.env.ENIO_WORKSPACE!, state!.file!), "utf8");
  assert.match(body, /Recording ended unexpectedly/);
});

test("startMeeting purges week-old scratch dirs and leaves fresh ones", () => {
  const root = join(process.env.ENIO_DATA_DIR!, "meetings");
  const old = join(root, "ancient");
  const fresh = join(root, "recent");
  mkdirSync(old, { recursive: true });
  mkdirSync(fresh, { recursive: true });
  const then = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(old, then, then);
  meetings.startMeeting(undefined, { transcribe: fakeTranscriber({}), installed });
  const remaining = readdirSync(root);
  assert.ok(!remaining.includes("ancient"), "old dir purged");
  assert.ok(remaining.includes("recent"), "fresh dir kept");
  meetings.cancelMeeting();
});
