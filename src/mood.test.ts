import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The reply-mood label. The classifier is driven by a deterministic
 * embedder: every authored example maps to its own label's axis, and a
 * query maps to whichever "[label]" tokens it carries -- so one token is a
 * clean win, two tokens tie at margin zero, and the thresholds are exact.
 */
const scratch = mkdtempSync(join(tmpdir(), "enio-mood-"));
process.env.ENIO_DATA_DIR = scratch;
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "mcp.json");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");

const mood = await import("./mood.js");
const { MOODS, MOOD_EXAMPLES, firstSentence, moodByRule, moodFor, classifyMood, createMoodTrack, setMoodEmbedder } = mood;
type Mood = (typeof MOODS)[number];
// Computed specifiers: plain-JS renderer code and a bench data file, loaded
// untyped rather than declared.
const SPEECH = "../desktop/renderer/src/lib/speech.js";
const DATA = "../scripts/mood-bench-data.mjs";

after(() => {
  setMoodEmbedder(null);
  rmSync(scratch, { recursive: true, force: true });
});

function vecFor(text: string): Float32Array {
  const v = new Float32Array(MOODS.length);
  const example = MOOD_EXAMPLES.find((e) => e.text === text);
  if (example) {
    v[MOODS.indexOf(example.mood)] = 1;
    return v;
  }
  for (const m of MOODS) if (text.includes(`[${m}]`)) v[MOODS.indexOf(m)] = 1;
  if (![...v].some(Boolean)) v[0] = 1;
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm) as Float32Array;
}
const fake = async (texts: string[]) => texts.map(vecFor);
const tick = () => new Promise((r) => setTimeout(r, 5));
const failed = { kind: "tool", output: "Error: no such file", error: "Error: no such file" };
const fine = { kind: "tool", output: "contents here" };

describe("the mood label", () => {
  test("four moods, and the first-sentence rule is the voice's own", async () => {
    assert.deepEqual([...MOODS], ["neutral", "happy", "sorry", "unsure"]);
    const { takeSentences } = (await import(SPEECH)) as { takeSentences: (s: string) => { ready: string[] } };
    for (const text of ["Done. The file is saved.", "Version 1.2.3 is out. Try it!", "See e.g. the docs. Then run it."]) {
      assert.equal(firstSentence(text), takeSentences(text).ready[0], text);
    }
    assert.equal(firstSentence("Done"), null, "no terminator yet");
    assert.equal(firstSentence("Done."), null, "a terminator without whitespace after it may still be mid-token");
    assert.equal(firstSentence("Running 127.0.0.1 now. Ok."), "Running 127.0.0.1 now.");
  });

  test("rules: a failed call the reply owns is sorry, and wins over unsure", () => {
    assert.equal(moodByRule("I couldn't read that file.", [failed]), "sorry");
    assert.equal(moodByRule("I don't have anything on that.", []), "unsure");
    assert.equal(moodByRule("I couldn't find that file anywhere.", [failed]), "sorry", "the failure is the more specific fact");
    assert.equal(moodByRule("Here is the summary.", [failed]), null, "an unacknowledged failure is not an apology");
    assert.equal(moodByRule("The file says hello.", [fine]), null);
  });

  test("classifier: the nearest authored example over the margin, else neutral", async () => {
    for (const m of MOODS) {
      const v = await moodFor(`[${m}] something the assistant said`, [], { embedder: fake });
      assert.equal(v.mood, m);
      assert.equal(v.how, "classifier");
      assert.ok(v.margin !== null && v.margin > 0.9, `a clean win: ${v.margin}`);
    }
    const tie = await moodFor("[happy][sorry] both at once", [], { embedder: fake });
    assert.equal(tie.mood, "neutral");
    assert.equal(tie.how, "fallback");
    assert.ok(tie.margin !== null && Math.abs(tie.margin) < 1e-6, "a tie has no margin");
  });

  test("never throws: empty, huge, and a throwing embedder all answer neutral", async () => {
    assert.equal((await moodFor("", [], { embedder: fake })).mood, "neutral");
    const huge = `[happy] ${"x".repeat(1_000_000)}`;
    assert.equal((await moodFor(huge, [], { embedder: fake })).mood, "happy", "the slice keeps the token");
    const boom = async () => {
      throw new Error("no model");
    };
    const v = await moodFor("[happy] fine", [], { embedder: boom });
    assert.deepEqual([v.mood, v.how], ["neutral", "fallback"]);
  });

  test("a turn never starts the embedding load", async () => {
    setMoodEmbedder(null);
    // Nothing has embedded in this process, so the gate is closed: the
    // classifier declines rather than triggering a model download.
    assert.equal(await classifyMood("[happy] anything"), null);
    const v = await moodFor("[happy] anything", []);
    assert.deepEqual([v.mood, v.how], ["neutral", "fallback"]);
  });

  test("the track labels at the first sentence, once", async () => {
    setMoodEmbedder(fake);
    const sent: Mood[] = [];
    const track = createMoodTrack([], (m) => sent.push(m));
    track.streamed("[happy] Done.");
    await tick();
    assert.deepEqual(sent, [], "a terminator with nothing after it is not yet a sentence");
    track.streamed(" And the tests pass.");
    await tick();
    assert.deepEqual(sent, ["happy"]);
    const step = await track.settle("[happy] Done. And the tests pass.");
    assert.deepEqual(sent, ["happy"], "settling a labelled reply sends nothing new");
    assert.equal(step?.how, "classifier");
    assert.equal(track.sent, "happy");
  });

  test("narration before a tool call is not the answer: the track re-arms", async () => {
    setMoodEmbedder(fake);
    const sent: Mood[] = [];
    const steps: Array<{ kind: string; output?: string }> = [];
    const track = createMoodTrack(steps, (m) => sent.push(m));
    track.streamed("[neutral] Let me check the file. ");
    await tick();
    steps.push(fine);
    track.rearm();
    track.streamed("[happy] It is there and it builds. ");
    await tick();
    await track.settle("[neutral] Let me check the file. [happy] It is there and it builds. ");
    assert.deepEqual(sent, ["neutral", "happy"]);
  });

  test("a withdrawn reply forgets its label, so the correction gets a frame even when it repeats", async () => {
    setMoodEmbedder(fake);
    const sent: Mood[] = [];
    const track = createMoodTrack([], (m) => sent.push(m));
    track.streamed("[neutral] First try. ");
    await tick();
    track.reset();
    assert.equal(track.sent, null);
    track.streamed("[neutral] Second try. ");
    await tick();
    await track.settle("[neutral] Second try. ");
    assert.deepEqual(sent, ["neutral", "neutral"]);
  });

  test("at the end only a rule may change the classifier's mind, and an unfinished sentence is labelled then", async () => {
    setMoodEmbedder(fake);
    const sent: Mood[] = [];
    const steps = [failed];
    const track = createMoodTrack(steps, (m) => sent.push(m));
    track.streamed("[happy] Great news. ");
    await tick();
    assert.deepEqual(sent, ["happy"], "the opening did not own the failure");
    const step = await track.settle("[happy] Great news. Still, I couldn't read the file.");
    assert.deepEqual(sent, ["happy", "sorry"]);
    assert.equal(step?.how, "rule");

    const late: Mood[] = [];
    const t2 = createMoodTrack([], (m) => late.push(m));
    t2.streamed("[happy] Done");
    await tick();
    assert.deepEqual(late, []);
    const s2 = await t2.settle("[happy] Done");
    assert.deepEqual(late, ["happy"]);
    assert.equal(s2?.how, "classifier");
    assert.equal(await createMoodTrack([], () => {}).settle("   "), null, "an empty reply is not labelled");
  });

  test("the held-out bench is disjoint from the examples and large enough to mean something", async () => {
    const { BENCH } = (await import(DATA)) as { BENCH: Array<[string, string]> };
    const examples = new Set(MOOD_EXAMPLES.map((e) => e.text.trim().toLowerCase()));
    assert.ok(BENCH.length >= 40, `${BENCH.length} replies`);
    for (const m of MOODS) {
      assert.ok(BENCH.filter(([, want]) => want === m).length >= 8, `bench has few ${m}`);
      assert.ok(MOOD_EXAMPLES.filter((e) => e.mood === m).length >= 8, `examples have few ${m}`);
    }
    for (const [reply, want] of BENCH) {
      assert.ok((MOODS as readonly string[]).includes(want), `${want} is not a mood`);
      assert.ok(!examples.has(reply.trim().toLowerCase()), `bench reply is also an example: ${reply}`);
    }
    assert.equal(new Set(MOOD_EXAMPLES.map((e) => e.text)).size, MOOD_EXAMPLES.length, "duplicate example");
  });
});
