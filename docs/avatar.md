---
title: Avatar
layout: default
nav_order: 20
---

# Avatar

A face for Enio in the app: a 3D head that speaks the replies the voice
already speaks, looks at you while you talk, glances down while it works,
and wears a mood the harness picked — never one the model claimed.

It adds no new mechanics. The voice loop, the sentence-by-sentence speech
and the turn stream are what they were; the face is one more thing reading
them. Everything it shows comes from events the window already receives.

## Turning it on

Click the face button in the status bar, or ask in chat — "open avatar",
"show your face". It appears as a thumbnail over the thread; hover it to
expand it into a side panel, shrink it back, or hide it. Off by default,
for the same reason replies are not read aloud until you ask: a face that
appears unasked is startling. The window remembers your choice.

With **Read replies aloud** on, the face speaks. Without it, the face still
reacts and the thumbnail says how to hear it.

## Installing a face

Enio ships no face in the app itself: the head is a file of tens of
megabytes, downloaded once into `~/.enio/avatar/`.

- **The default head** — `enio addons add avatar`, or the *Set up* button in
  the empty thumbnail. A 21 MB download: a male head built from MakeHuman's
  CC0 assets with Blender and the MPFB extension, by a script in this repo
  (see below), so it is yours to use and redistribute.
- **Bring your own** — any GLB that meets the requirements below:

  ```bash
  enio avatar use ~/Downloads/me.glb
  ```

  [Avaturn](https://avaturn.me) makes one from a photo (free for
  non-commercial use; export a *Type 2* avatar as GLB). Then, if it is a
  female body form, `enio avatar body F` so the idle poses fit.
- **A file somewhere else** — `ENIO_AVATAR=/path/to/face.glb` in the
  environment points the agent at it without copying.

`enio avatar` shows what is installed; `enio avatar remove` drops the file
you brought and falls back to the default.

### What the file needs

The face is driven by the open-source
[TalkingHead](https://github.com/met4citizen/TalkingHead) library, which
expects:

- a Mixamo-compatible rig whose root object is named `Armature`, with
  `LeftEye` and `RightEye` bones;
- the 52 ARKit face blend shapes and the 15 Oculus viseme shapes
  (`viseme_sil`, `viseme_PP`, … `viseme_U`);
- plain geometry — no Draco or meshopt compression.

### Building a CC0 face yourself

The default head comes out of one command, given Blender 4.2 or later with
the MPFB extension installed:

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/avatar/build-enio-head.py -- ~/enio-head.glb
```

The script fetches TalkingHead's rig, weights and target files and the four
MakeHuman asset packs it needs (about 330 MB, once), builds the human,
rigs it, dresses it, bakes the Meta visemes and ARKit face units into every
part, fixes the materials the glTF exporter would otherwise make
transparent, re-orients the spine so the library's standing pose lands as
a near-zero change, and writes the GLB. Body shape, skin, hair and outfit
are variables at the top of the script; `HEAD_GENDER=0` builds a woman.
Three knobs tune the eyes for the library's idle gaze, which sits a little
below the camera: HEAD_EYE_OPEN makes the resting opening taller than
MakeHuman's default (0.6), HEAD_LID_FOLLOW is how much of the eyelid motion
the look-down and look-up shapes keep (0.3 — the library adds its own
lid-follow on top), and HEAD_BLINK_LOWER is how far the lower lid joins a
blink (0.3).
TalkingHead's own
[MPFB guide](https://github.com/met4citizen/TalkingHead/blob/main/blender/MPFB/MPFB.md)
documents the same steps by hand.

## What drives the face

| You see | Because |
|---|---|
| Eyes on you | a turn started, or your words landed |
| A glance up | the model is thinking (once per stretch, not per token) |
| A look down | a tool is running; a failed call brings the eyes back up |
| Brows up, eye contact | voice mode is listening, and the microphone hears you |
| The mouth moving | a sentence is being spoken |
| A reset to neutral | the harness withdrew the reply and is correcting it |
| Eyes closing | nobody has touched the window — no pointer, key, turn or speech — for fifteen minutes |

The **mood** is one of four labels — neutral, happy, sorry, unsure — chosen
by the harness per reply:

1. a failed tool call the reply owns up to is *sorry*;
2. a reply the abstention grammar recognises ("I don't have anything on
   that") is *unsure*;
3. otherwise the nearest authored example decides, when its margin over the
   runner-up clears `ENIO_MOOD_MARGIN` (0.03, the knee of
   `scripts/mood-bench.mjs`); below it the face stays neutral.

The label travels with the reply, is recorded as a `mood` step in the trace
and comes back when you reopen a conversation. The model is never asked how
it feels; asking would cost tokens on every turn and would be the
self-judgement a small model gets wrong.

## Speech timing

The voice hands back audio and nothing else, so the mouth is shaped from
each sentence's words shared across the clip's length. Sentence-sized
clips keep the error small. When the speech route can also return
per-phoneme timing, the face will use it; `capabilities.voice.timings`
says whether it can.

## Privacy

The model file is a local file served to the window over the authed
loopback route, like every other request. The face reads events already in
the window. Nothing leaves the machine.

## Limitations

- Lip-sync is approximate (see above) and the shape rules are English.
- The default head is not published yet; bring your own meanwhile.
- The face lives inside the chat window. A floating always-on-top
  companion window is a later step.
