---
title: Controlling your computer
layout: default
nav_order: 9
---

# Controlling your computer

Enio can read from your computer's apps, open them, and — with your approval —
click buttons, choose menu commands and type. Today this is built on macOS
(AppleScript, the accessibility tree, per-app Automation permissions); the
ideas — propose, approve, then run — are not Mac-specific. This page covers
what it can do, what needs permission, and where the line is between "it just
does that" and "it asks first".

## The two switches

They answer different questions, and they are deliberately not one switch.

| | Question it answers | Default |
|---|---|---|
| **Desktop control** | May it change anything at all? | off |
| **Run safe scripts automatically** | May a *vouched* script run without asking? | off |

The first is one deliberate click: pick **Control my computer** (or **Screenshot**)
on the launcher and press **Enable desktop control**. The consent is recorded
machine-wide and survives restarts; macOS still asks its own per-app
Automation and Screen Recording permissions on first use, which is the layer
that actually protects each app's data. `ENIO_DESKTOP=1` remains the
environment-variable form of the same switch, and wins when set:

```sh
cd desktop && ENIO_DESKTOP=1 npm start
```

The second lives on the **Scripts** tab of the Automations panel, not in an
environment variable, because it is a decision you revisit. Turning both on in
one gesture would be bundled consent.

Why off by default at all: with desktop control on, the shell allowlist grows
`osascript`, `open` and friends — direct execution paths with no approval
sheet between them and your apps. A small model can be talked into things by
content it reads, so the ability to reach your apps is something you grant,
never something that ships pre-granted.

{: .warning }
Auto-run applies **only to scripts you personally ticked "safe"**. A plan Enio
has just written always goes to the approval sheet, whatever that switch says.
That line is not negotiable by any setting.

## What works without any flag

Reading is not irreversible, so it needs no flag — macOS's own permission
prompts are the consent that protects your data.

**Opening an app you asked for** needs no flag either, and no plan:

```
you › open Spotify
```

The name resolves against what is actually installed, so a typo is refused with
the real list rather than guessed at. Partial names work — "chrome" finds
Google Chrome. Quitting the app undoes it, which is the whole test the
`ENIO_DESKTOP` gate applies.

**An app you did not ask for is not opened.** When Enio decides on its own
that something needs an app — you asked what is on a web page, and it reaches
for the browser — it does not open it. If the app is already open it carries
on; if not, you get a one-step plan, "Open Google Chrome", with **Run** and
**Discard** on the card. Run it, say "go on", and Enio plans the rest. This
one plan runs without desktop control switched on, because it does exactly
what "open Chrome" would have done had you typed it.

**Reading from apps** goes through `mac_recipe`, which runs tested scripts
selected by name rather than written on the spot:

| Script | Returns | Needs |
|---|---|---|
| `recent_emails` | The most recent messages in the Mail app's inbox: how old, read or unread, sender, subject | Automation |
| `unread_emails` | The unread messages in the Mail app's inbox, newest first | Automation |
| `unread_count` | How many unread messages are in the Mail app's inbox | Automation |
| `latest_email_body` | Full text of the most recent message in the Mail app | Automation |
| `todays_events` | Calendar events starting today | Automation |
| `open_reminders` | Reminders not yet completed | Automation |
| `recent_notes` | Titles of recent notes | Automation |
| `desktop_files` | Files on the Desktop | Automation |
| `running_apps` | Which apps are open | nothing |
| `window_controls` | An app's front-window buttons and fields, by name | Accessibility |
| `menu_items` | An app's menu commands, as `File > Save` lines | Accessibility |

The last two are the only ones withheld without Accessibility permission.

The mail scripts read the **Mail app**, and say so at the top of what they
return. They cannot read mail shown on a web page: asked for mail "in
Safari", the script refuses instead of reading the Mail app under another
name ("Gmail" is not the Mail app either). Every result opens with how
many messages the inbox holds and how old the newest one is, each row says
how many days old its message is, and when the newest message in the
whole inbox is more than two days old the result says the Mail app is not
showing recent mail — an account that stopped syncing looks like an inbox
otherwise. You see that as a note beside the reply as well.

**"The browser" is yours.** Asked to open "the browser", Enio opens the one
you named; otherwise the one you already have open; otherwise the one your
Mac opens links in. It does not pick one itself, and the result says which
it used and why. A short name finds the app, not a tool for the app:
"Chrome" is Google Chrome, never an uninstaller that happens to start with
the word.

**Screenshots show up in the thread.** The reply's text is the vision
model's reading of the screen; the desktop also shows the captured image
under it, because a reading is sometimes wrong and the pixels are the check.
Click it to open the full-size capture.

**Screenshots leave enio out.** A screenshot is meant to answer "what is on
my screen", and enio's own window is never that answer — it is in front
because you just typed into it, and leaving it in means the model reads its
own conversation back as evidence. So enio hides itself for the length of
the capture and comes straight back, whatever the result. Hiding needs
Automation permission; without it you get the shot with enio still in frame
rather than no shot at all. Asking for just the front window captures the
window you were actually looking at, for the same reason.

## Clicking by name, never by coordinate

macOS publishes every button, field and menu item of every window *by name*
through the accessibility tree. Enio reads that list and picks from it, so
"click Save" needs no coordinates and no eyesight.

This fails in the right direction. A click by coordinate lands on whatever
happens to be at those pixels now — after a scroll or a relayout, the wrong
control, silently. A click by name either finds the name or errors.

Reading, pressing and typing go through a small Python helper
(`scripts/ax_bridge.py`) that talks to the accessibility API directly, falling
back to AppleScript when it isn't installed. That matters for more than speed:
some apps — Calculator among them — report **zero windows** to AppleScript's
System Events while exposing every button to the API underneath.

The bridge reads the window you are looking at (the focused one, not just the
first), fetches each element's attributes in one round-trip, names unlabeled
controls from their developer identifiers, and answers instead of hanging when
an app is wedged. Typing through it sets the field's value directly — the app
does not need to be brought forward, and a **password field is refused by
role**: the bridge cannot type into one even if asked. A press that opens a
dialog reports itself as *dispatched but unconfirmed* rather than pretending
to know. Several of these techniques are borrowed from
[Peekaboo](https://github.com/steipete/peekaboo) (MIT), reimplemented on the
public API.

## Plans, and the approval sheet

When no saved script covers what you asked, Enio writes down what it *would* do and
stops. It cannot run it; only you can. The reply lists the steps and says
nothing has run; the card under it is where you decide. There are four things
to do with a plan:

- **Run it** — from the sheet, after reading what each step runs.
- **Change it** — edit a step's text, or describe a change and have the steps
  rewritten.
- **Discard it.**
- **Try again** — set this plan aside and have Enio write a new one for the
  same request. Your request is asked again in the conversation, and Enio is
  told which plan you turned down so the new one is not the same plan twice.

In the terminal there is no card: `/run` prints every step with the exact
text it would run, `/run ID` (the id it printed) runs it, and `/discard`
drops it.

When a plan has run, what it did is written into the conversation: each step,
whether it worked, and what it printed. A plan that stopped part-way says
where, which steps already ran and which did not. Because the output is in
the thread, you can ask about it afterwards.

A step is one action, and can be any of these:

| Step | Example | What it does |
|---|---|---|
| `open` | `"Calendar"` | Opens or fronts an app |
| `click` | `"Save"` | Clicks a control by name |
| `menu` | `"File > New Note"` | Chooses a menu command |
| `type_text` | `"milk, eggs"` | Types into the app's focused field (without fronting it, when the bridge is installed) |
| `press` | `"return"` | Presses one named key |
| `script` | AppleScript | For when no named action fits |
| `shell` | `git status` | A shell command |
| `python` | `print(6*7)` | A Python script |

Shell and Python matter more than they look. The model writes Python far better
than it writes AppleScript, so moving work down from GUI scripting to a library
call improves both what runs and what gets written.

**The sheet is a review, not a yes/no.** For every step you can:

- **read** the exact script that will run — never a description of it
- **edit** it, and what you edited is what runs
- **test that one step alone**, without approving the rest
- **describe a change** — "do this in Python" — and have the steps rewritten,
  with one-click undo

Steps run in order and stop at the first failure, so a half-finished plan is
visible as a half-finished plan rather than an error with no account of what
already happened.

## Turning a plan into a saved script

This is the part worth understanding, because it is the only thing in the
design that converts a one-off into permanent capability.

Approve a plan and choose **Save as script**, give it a name, and from then on
the model *selects* it by name instead of writing it again. The model
improvises once — expensive and unreliable — you approve once, and after that
it is deterministic with no model involved.

A script is only saved **after every step ran successfully**. A script that
never worked would otherwise be re-run verbatim forever, failing identically,
with nothing positioned to notice.

**The same request later finds the script.** A saved script remembers what
you asked for when the plan was written. Ask for the same thing again and
Enio offers the script straight away, with no new plan written: the card
names it and has **Run** on it. "The same thing" is strict: the same words
in the same order, with the same numbers and quoted names. Only the dressing
may differ — "please", "can you", "the", a plural, capitals, accents. One
word changed is a different request ("turn *off* dark mode" is not "turn
*on* dark mode") and goes to Enio as usual, which can still pick the script
by name. It is never run from the match alone; one press is the
confirmation. If the script is not what you meant, **Try again** has Enio
write a fresh plan instead. A script saved from an "Open X" plan that Enio
proposed on its way to something else is not found this way: opening the
app was a first step, not the answer to what you asked.

Tick **"safe to run on its own"** while saving, and with auto-run enabled Enio
uses that script without asking. Saving records that a script *worked*; ticking
safe records that you are willing to have it repeat unattended. Those are
different judgements, and only you can make the second.

Manage them all on the **Scripts** tab of the Automations panel (the workflow
button in the status bar): built-ins are listed but not editable, yours can be
edited, tested, vouched for or deleted. You can also write one from scratch
there — saving runs it once and refuses to store it if it fails.

They sit beside the automations rather than in a drawer of their own because
they are the same kind of thing: something that *runs*, picked by name from a
list you curate. [Skills](skills.md) — know-how in words, which informs but
cannot act — get their own button instead. Two surfaces, one line between
them: one acts, the other advises.

## When something is refused

| Message | Means |
|---|---|
| "needs Accessibility access" | Grant it in System Settings → Privacy & Security → Accessibility |
| "is not installed" / "is not running" | The app name did not resolve; the real list is in the message |
| "no control named X" | The name is not in the current window — read `window_controls` again |
| "needs desktop mode" | Start with `ENIO_DESKTOP=1` |
| An Electron app (VSCodium, Slack, Figma…) says it has no focused field or no controls | Those apps build their accessibility tree only when asked; Enio asks on every step, and the first action after the app launches can take a second to see it. Retry the step. |
| "no window is visible to scripting" | The app hides its window from System Events; keystrokes still reach it |
