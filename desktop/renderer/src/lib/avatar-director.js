/**
 * What the face does, decided from what the window already knows.
 *
 * Nothing here asks the model anything. Every input is an event the chat
 * window receives anyway -- the turn starting, the model thinking, a tool
 * running, a call failing, the first words, the harness's mood label, a
 * withdrawn reply, the voice loop's state, the microphone hearing the user
 * -- and every output is one of a few commands the pane can carry out.
 *
 * Pure: no timers, no DOM, a clock passed in. The director lives in the
 * window, not in the pane, because events flow whether or not a face is
 * visible; a pane that mounts mid-session catches up from snapshot().
 *
 * Outputs are emitted on CHANGE: forty "thinking" frames produce one glance
 * up, not forty. Gestures are the exception, since repeating one is the
 * point of asking for it.
 */

export const SLEEP_AFTER_MS = 5 * 60_000;
export const AFTERGLOW_MS = 6_000;

/** The harness's labels, mapped to the moods the face can show. */
const FACE = { neutral: "neutral", happy: "happy", sorry: "sad", unsure: "neutral" };

export function createAvatarDirector({ sleepAfterMs = SLEEP_AFTER_MS, afterglowMs = AFTERGLOW_MS } = {}) {
  const s = {
    mood: "neutral",
    gaze: "ahead",
    listening: false,
    asleep: false,
    streaming: false,
    inVoice: false,
    working: false,
    glancedUp: false,
    lastActivity: 0,
    afterglowUntil: null,
  };
  let out = [];
  const setMood = (m) => {
    if (s.mood === m) return;
    s.mood = m;
    out.push({ cmd: "mood", mood: m });
  };
  const setGaze = (target) => {
    if (s.gaze === target) return;
    s.gaze = target;
    out.push({ cmd: "gaze", target });
  };
  const setListening = (on) => {
    if (s.listening === on) return;
    s.listening = on;
    out.push({ cmd: "listening", on });
  };
  const wake = (now) => {
    s.lastActivity = now;
    if (!s.asleep) return;
    s.asleep = false;
    // Sleep was shown on top of the real mood; waking shows the real one.
    out.push({ cmd: "mood", mood: s.mood });
  };
  const take = () => {
    const batch = out;
    out = [];
    return batch;
  };

  return {
    handle(event, now) {
      wake(now);
      switch (event.type) {
        case "turn-start":
          s.streaming = true;
          s.working = false;
          s.glancedUp = false;
          s.afterglowUntil = null;
          setMood("neutral");
          setGaze("camera");
          break;
        case "think":
          // Once per thinking stretch: the model thinks between tools too.
          if (!s.glancedUp) {
            s.glancedUp = true;
            setGaze("up");
          }
          break;
        case "tool-start":
          s.glancedUp = false;
          if (!s.working) {
            s.working = true;
            setGaze("down");
          }
          break;
        case "call-end":
          if (event.status === "failed" || event.status === "refused") {
            // A glance up from the work when something went wrong.
            s.working = false;
            setGaze("camera");
          }
          break;
        case "first-text":
          s.working = false;
          s.glancedUp = false;
          setGaze("camera");
          break;
        case "mood":
          if (!(event.mood in FACE)) break; // a closed list; the model never names it
          setMood(FACE[event.mood]);
          if (event.mood === "unsure") out.push({ cmd: "gesture", name: "shrug" });
          break;
        case "restart":
          s.working = false;
          s.glancedUp = false;
          setMood("neutral");
          setGaze("camera");
          break;
        case "turn-end":
          s.streaming = false;
          s.working = false;
          s.glancedUp = false;
          if (event.error) setMood("sad");
          setGaze("ahead");
          s.afterglowUntil = s.mood === "neutral" ? null : now + afterglowMs;
          break;
        case "voice":
          s.inVoice = event.state != null;
          if (event.state === "listening") {
            setListening(true);
            setGaze("camera");
          } else {
            setListening(false);
          }
          break;
        case "user-level":
          if (event.speaking) setGaze("camera");
          break;
        case "reset":
          s.streaming = false;
          s.working = false;
          s.glancedUp = false;
          s.afterglowUntil = null;
          setMood("neutral");
          setGaze("ahead");
          setListening(false);
          break;
        default:
          // route, notice, basis: known to the window, nothing for the face.
          break;
      }
      return take();
    },

    tick(now) {
      if (s.lastActivity === 0) s.lastActivity = now;
      if (s.afterglowUntil !== null && now >= s.afterglowUntil && !s.streaming) {
        s.afterglowUntil = null;
        setMood("neutral");
      }
      // Never asleep while listening or mid-answer: a face that dozes off
      // while you talk to it is worse than no face.
      if (!s.asleep && !s.inVoice && !s.streaming && now - s.lastActivity >= sleepAfterMs) {
        s.asleep = true;
        out.push({ cmd: "mood", mood: "sleep" });
      }
      return take();
    },

    /** The commands that reproduce the current state, for a pane mounting late. */
    snapshot() {
      return [
        { cmd: "mood", mood: s.asleep ? "sleep" : s.mood },
        { cmd: "gaze", target: s.gaze },
        { cmd: "listening", on: s.listening },
      ];
    },
  };
}
