---
title: Controlling your Mac
layout: default
nav_order: 6
---

# Controlling your Mac

Enio can read from your Mac's apps, open them, and — with your approval — click
buttons, choose menu commands and type. This page covers what it can do, what
needs permission, and where the line is between "it just does that" and "it
asks first".

## The two switches

They answer different questions, and they are deliberately not one switch.

| | Question it answers | Default |
|---|---|---|
| `ENIO_DESKTOP=1` | May it change anything at all? | off |
| **Run safe recipes automatically** | May a *vouched* script run without asking? | off |

```sh
cd desktop && ENIO_DESKTOP=1 npm start
```

The second lives in the Recipes drawer, not in an environment variable, because
it is a decision you revisit. Turning both on in one gesture would be bundled
consent.

{: .warning }
Auto-run applies **only to recipes you personally ticked "safe"**. A plan Enio
has just written always goes to the approval sheet, whatever that switch says.
That line is not negotiable by any setting.

## What works without any flag

Reading is not irreversible, so it needs no flag — macOS's own permission
prompts are the consent that protects your data.

**Opening an app** needs no flag either, and no plan:

```
you › open Spotify
```

The name resolves against what is actually installed, so a typo is refused with
the real list rather than guessed at. Partial names work — "chrome" finds
Google Chrome. Quitting the app undoes it, which is the whole test the
`ENIO_DESKTOP` gate applies.

**Reading from apps** goes through `mac_recipe`, which runs tested scripts
selected by name rather than written on the spot:

| Recipe | Returns | Needs |
|---|---|---|
| `recent_emails` | Subject and sender of recent inbox messages | Automation |
| `unread_count` | How many unread messages | Automation |
| `latest_email_body` | Full text of the most recent message | Automation |
| `todays_events` | Calendar events starting today | Automation |
| `open_reminders` | Reminders not yet completed | Automation |
| `recent_notes` | Titles of recent notes | Automation |
| `desktop_files` | Files on the Desktop | Automation |
| `running_apps` | Which apps are open | nothing |
| `window_controls` | An app's front-window buttons and fields, by name | Accessibility |
| `menu_items` | An app's menu commands, as `File > Save` lines | Accessibility |

The last two are the only ones withheld without Accessibility permission.

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

When no recipe covers what you asked, Enio writes down what it *would* do and
stops. It cannot run it; only you can.

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

## Turning a plan into a recipe

This is the part worth understanding, because it is the only thing in the
design that converts a one-off into permanent capability.

Approve a plan and choose **Save as recipe**, give it a name, and from then on
the model *selects* it by name instead of writing it again. The model
improvises once — expensive and unreliable — you approve once, and after that
it is deterministic with no model involved.

A recipe is only saved **after every step ran successfully**. A script that
never worked would otherwise be re-run verbatim forever, failing identically,
with nothing positioned to notice.

Tick **"safe to run on its own"** while saving, and with auto-run enabled Enio
uses that recipe without asking. Saving records that a script *worked*; ticking
safe records that you are willing to have it repeat unattended. Those are
different judgements, and only you can make the second.

Manage them all in the **Recipes** drawer in the status bar: built-ins are
listed but not editable, yours can be edited, tested, vouched for or deleted.
You can also write one from scratch there — saving runs it once and refuses to
store it if it fails.

## When something is refused

| Message | Means |
|---|---|
| "needs Accessibility access" | Grant it in System Settings → Privacy & Security → Accessibility |
| "is not installed" / "is not running" | The app name did not resolve; the real list is in the message |
| "no control named X" | The name is not in the current window — read `window_controls` again |
| "needs desktop mode" | Start with `ENIO_DESKTOP=1` |
| "no window is visible to scripting" | The app hides its window from System Events; keystrokes still reach it |
