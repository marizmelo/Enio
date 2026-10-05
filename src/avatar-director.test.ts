import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * The face's director: window events in, a few commands out, emitted on
 * change. Driven with an explicit clock, since sleeping and the mood's
 * afterglow are the only time-dependent parts.
 */
const LIB = "../desktop/renderer/src/lib/avatar-director.js";
interface Cmd {
  cmd: string;
  mood?: string;
  target?: string;
  name?: string;
  on?: boolean;
}
interface Director {
  handle(event: Record<string, unknown>, now: number): Cmd[];
  tick(now: number): Cmd[];
  snapshot(): Cmd[];
}
const { createAvatarDirector } = (await import(LIB)) as {
  createAvatarDirector: (o?: { sleepAfterMs?: number; afterglowMs?: number }) => Director;
};
const moods = (cmds: Cmd[]) => cmds.filter((c) => c.cmd === "mood").map((c) => c.mood);
const gazes = (cmds: Cmd[]) => cmds.filter((c) => c.cmd === "gaze").map((c) => c.target);
const gestures = (cmds: Cmd[]) => cmds.filter((c) => c.cmd === "gesture").map((c) => c.name);

describe("the avatar director", () => {
  test("a turn: eyes on the user, one glance up while thinking, down once while working, back at the first words", () => {
    const d = createAvatarDirector();
    const t = 1000;
    assert.deepEqual(d.snapshot()[1], { cmd: "gaze", target: "camera" }, "eye contact is the resting state");
    assert.deepEqual(gazes(d.handle({ type: "turn-start" }, t)), [], "already looking at the user");
    const thinking = [...d.handle({ type: "think" }, t + 1), ...d.handle({ type: "think" }, t + 2), ...d.handle({ type: "think" }, t + 3)];
    assert.deepEqual(gazes(thinking), ["up"], "forty think frames are one glance");
    const working = [
      ...d.handle({ type: "tool-start", name: "read_file" }, t + 4),
      ...d.handle({ type: "call-end", status: "ok" }, t + 5),
      ...d.handle({ type: "tool-start", name: "search_code" }, t + 6),
    ];
    assert.deepEqual(gazes(working), ["down"], "one look down per stretch of work");
    assert.deepEqual(gazes(d.handle({ type: "first-text" }, t + 7)), ["camera"]);
    assert.deepEqual(gazes(d.handle({ type: "turn-end", error: false }, t + 8)), [], "and stays on the user afterwards");
  });

  test("a failed call is a glance up from the work, and the next tool looks down again", () => {
    const d = createAvatarDirector();
    d.handle({ type: "turn-start" }, 0);
    assert.deepEqual(gazes(d.handle({ type: "tool-start", name: "run_command" }, 1)), ["down"]);
    assert.deepEqual(gazes(d.handle({ type: "call-end", status: "failed" }, 2)), ["camera"]);
    assert.deepEqual(gazes(d.handle({ type: "tool-start", name: "run_command" }, 3)), ["down"]);
  });

  test("labels map to faces; unsure shrugs; an unknown label does nothing", () => {
    const d = createAvatarDirector();
    d.handle({ type: "turn-start" }, 0);
    assert.deepEqual(moods(d.handle({ type: "mood", mood: "happy" }, 1)), ["happy"]);
    const unsure = d.handle({ type: "mood", mood: "unsure" }, 2);
    assert.deepEqual(moods(unsure), ["neutral"]);
    assert.deepEqual(gestures(unsure), ["shrug"]);
    assert.deepEqual(moods(d.handle({ type: "mood", mood: "sorry" }, 3)), ["sad"]);
    assert.deepEqual(d.handle({ type: "mood", mood: "ecstatic" }, 4), [], "the list is closed");
    assert.deepEqual(d.handle({ type: "notice" }, 5), []);
    assert.deepEqual(d.handle({ type: "basis", basis: "web" }, 6), []);
  });

  test("a withdrawn reply resets the face and the eyes", () => {
    const d = createAvatarDirector();
    d.handle({ type: "turn-start" }, 0);
    d.handle({ type: "mood", mood: "happy" }, 1);
    d.handle({ type: "tool-start", name: "x" }, 2);
    const r = d.handle({ type: "restart" }, 3);
    assert.deepEqual(moods(r), ["neutral"]);
    assert.deepEqual(gazes(r), ["camera"], "back from the work to the user");
  });

  test("a mood lingers after the turn, then fades; a failed turn is sad", () => {
    const d = createAvatarDirector({ afterglowMs: 100 });
    d.handle({ type: "turn-start" }, 0);
    d.handle({ type: "mood", mood: "happy" }, 1);
    d.handle({ type: "turn-end", error: false }, 10);
    assert.deepEqual(d.tick(50), [], "still glowing");
    assert.deepEqual(moods(d.tick(120)), ["neutral"]);
    const e = createAvatarDirector();
    e.handle({ type: "turn-start" }, 0);
    assert.deepEqual(moods(e.handle({ type: "turn-end", error: true }, 1)), ["sad"]);
  });

  test("it dozes off when idle, never in voice mode or mid-answer, and any event wakes it", () => {
    const d = createAvatarDirector({ sleepAfterMs: 1000 });
    d.handle({ type: "turn-start" }, 0);
    d.handle({ type: "mood", mood: "happy" }, 1);
    d.handle({ type: "turn-end", error: false }, 2);
    assert.deepEqual(d.tick(900), []);
    assert.deepEqual(moods(d.tick(1100)), ["sleep"]);
    assert.deepEqual(d.snapshot()[0], { cmd: "mood", mood: "sleep" });
    const woke = d.handle({ type: "user-level", speaking: true }, 1200);
    assert.deepEqual(moods(woke), ["happy"], "waking restores the real mood, which was still glowing");
    assert.deepEqual(gazes(woke), [], "it never looked away");

    // The person's presence counts, not only turns: a pointer over the
    // window at 900ms pushes sleep out, and the same event wakes a sleeper.
    const p = createAvatarDirector({ sleepAfterMs: 1000 });
    p.handle({ type: "shown" }, 0);
    p.handle({ type: "activity" }, 900);
    assert.deepEqual(p.tick(1500), [], "presence reset the idle clock");
    assert.deepEqual(moods(p.tick(2000)), ["sleep"]);
    assert.deepEqual(moods(p.handle({ type: "activity" }, 2100)), ["neutral"], "presence wakes");

    const v = createAvatarDirector({ sleepAfterMs: 1000 });
    const listening = v.handle({ type: "voice", state: "listening" }, 0);
    assert.deepEqual(listening.filter((c) => c.cmd === "listening"), [{ cmd: "listening", on: true }]);
    assert.deepEqual(v.tick(5000), [], "no sleeping while in voice mode");
    assert.deepEqual(v.handle({ type: "voice", state: "thinking" }, 5001).filter((c) => c.cmd === "listening"), [{ cmd: "listening", on: false }]);
    v.handle({ type: "voice", state: null }, 5002);
    assert.deepEqual(moods(v.tick(6500)), ["sleep"], "out of voice mode the clock runs again");

    const s = createAvatarDirector({ sleepAfterMs: 1000 });
    s.handle({ type: "turn-start" }, 0);
    assert.deepEqual(s.tick(5000), [], "no sleeping mid-answer");

    // Seen live: the window idled for hours with no pane mounted, so no ticks
    // ran; the pane then mounted, ticked once, and the face fell asleep.
    const late = createAvatarDirector({ sleepAfterMs: 1000 });
    late.handle({ type: "voice", state: null }, 0);
    late.handle({ type: "shown" }, 50_000);
    assert.deepEqual(late.tick(50_015), [], "being shown counts as activity");
    assert.deepEqual(moods(late.tick(51_100)), ["sleep"], "and the clock runs from there");
  });

  test("snapshot reproduces the state for a pane that mounts late, and reset returns to defaults", () => {
    const d = createAvatarDirector();
    d.handle({ type: "turn-start" }, 0);
    d.handle({ type: "mood", mood: "happy" }, 1);
    d.handle({ type: "voice", state: "listening" }, 2);
    assert.deepEqual(d.snapshot(), [
      { cmd: "mood", mood: "happy" },
      { cmd: "gaze", target: "camera" },
      { cmd: "listening", on: true },
    ]);
    d.handle({ type: "tool-start", name: "x" }, 3);
    const r = d.handle({ type: "reset" }, 4);
    assert.deepEqual(moods(r), ["neutral"]);
    assert.deepEqual(gazes(r), ["camera"]);
    assert.deepEqual(r.filter((c) => c.cmd === "listening"), [{ cmd: "listening", on: false }]);
  });
});
