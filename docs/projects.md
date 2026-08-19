---
title: Projects
layout: default
nav_order: 4
---

# Projects

A project gives Enio standing context for a body of work: what it is about,
how you want it handled, and which files and folders matter — each with a
note saying what it is for. Open a project and every conversation under it
carries that context; close it and everything reverts.

```sh
enio project new game --type code --desc "my Godot platformer"
enio project attach game ~/code/platformer --note "the game source"
enio project attach game ~/Documents/design.md --note "the design doc"
enio project open game
```

In the desktop app the same lives behind the briefcase icon in the status
bar: create a project, attach files and folders with the picker, write
instructions, and open it. The chip then shows which project is active,
because an open project quietly shapes every turn — and carries an **×** to
close it, since ending a scope should be as easy as granting it. Closing
only ends the session's scope: the project, its instructions and every
attached file stay exactly as they were.

## Not a mode

Tools like Claude Code make the folder the identity: you `cd` in and enter
code mode. Enio deliberately does not. A project is a *contextual overlay* —
routing keeps working, so a question about email inside a code project still
goes to the mail agent. What the project adds:

- **A prior for the router.** A `code` project makes the ambiguous "fix this"
  mean the coder; it never overrides a plainly different request.
- **Instructions and notes in the prompt.** Every agent sees the project's
  one-line description, its instructions, and the attachment list with your
  notes.
- **Wider (but still granted) file access** — see below.
- **Project skills.** A `skills/` folder inside the project shadows global
  skills by name while it is open. Scaffold one with
  `enio skills --new NAME --project NAME`.

## Types

`general`, `code`, or `planning`. The type is a template and a routing prior,
never a hard mode. Two example skills ship for them: `delegate-coding` (for
`code` — hand a big change to Claude Code or Gemini CLI if installed, see
below) and `project-planning` (for `planning`). Copy them into a project with
`enio skills --install-examples` and the project editor, or just keep them
global.

## How paths work

Each attachment is addressed by its **alias** — its folder or file name,
shown in the project editor. The alias is the first path segment everywhere:
`read_file` on `platformer/src/player.gd` reads inside the attached folder
whose alias is `platformer`. Plain relative paths (`notes.md`) are the
project's own storage: files the agent creates land inside the project's
folder under `~/.enio/projects/`, not in the global workspace — delete the
project and its generated files go with it. Conversation attachments stay in
the global workspace and remain readable either way; an attachment can never
fail a turn.

`run_command` runs in the sole attached folder when there is exactly one, and
takes an `in` parameter naming an alias when there are several.

## Editing and verification

Three things the harness does for the coder, because at this model size
asking for them in the prompt measurably did not produce them:

**Look before you guess.** When your message names a file — `src/greet.ts`,
`README.md` — the harness runs `search_code` for that name *before* the
model's first call, so the path it then uses is one it was shown rather than
one it remembered. Every path error in the coder's traces had been a guessed
name. Project-only: without a project open, search is content-only, and "no
matches" for a file that exists would mislead.

**Edits are exact, not rewrites.** The coder changes an existing file with
`edit_file` — an `old_string` that must appear exactly once, and the
`new_string` to put in its place. Zero matches or more than one is an error
naming the file, and nothing is written. `write_file` stays for new files
and whole documents. Whole-file rewrites were the only write before, and a
small model asked to fix one line of a long file regenerates the rest and
drifts. (If the model copies the passage out of `read_file`'s numbered
output, gutter included, the gutter is stripped — only on a miss, and only
when every line carries it.)

**The tests run after the edit.** The first time a turn writes a code file,
the harness runs the project's **verify command** and the model sees the
result before it answers — once per turn, not after every write. The command
is the one set in the project editor, or, left blank, detected from the
attached repo: `npm test` when `package.json` has a real test script, else
`npx tsc --noEmit` when there is a `tsconfig.json`; `cargo check`;
`go build ./...`; `python3 -m pytest -q`. Documents (`.md`, `.txt`) trigger
nothing. A saved verify command is checked against the command allowlist
when you save it — a command the shell would refuse is refused in the
dialog, not at 3am.

Conversations can hold standing attachments of their own (**Add to
conversation…** in the composer's + menu) with the same alias grammar, the
same refusals (no attaching `/`, your home folder, or enio's own data), and
the same 120-character note cap — refused, never truncated. When a project is
open, its aliases win a name collision: the project is the context you
deliberately opened, so a conversation attachment can never shadow it.

## Search

The coder has a `search_code` tool: query in, ranked `path:line` locations
out. It also matches file *names* (the index covers paths), which is what
the look-before-guess seed above relies on. It is deterministic — SQLite full-text search over the attached folders
plus live ripgrep, no embeddings — and its index lives inside the project
folder, refreshed incrementally. In a git repository it indexes what
`git ls-files` reports, so `.gitignore`d build output and `.env` secrets stay
out. PDFs are indexed by their extracted text layer, so "find X in my resume"
works; other binary files and anything over 512KB are skipped. Without a
project open it searches the workspace.

`AGENTS.md` and `CLAUDE.md` files in attached repos get no special treatment:
they are indexed and searchable like any other file, and they are a signal
the repo is set up for the provider CLIs the `delegate-coding` skill knows
how to drive (add `claude` or `gemini` to `ENIO_EXTRA_COMMANDS` to allow
that).

## The caps

The description, instructions, and per-attachment notes load into the model's
context on **every** project turn, and Enio's context budget follows the
selected model — the smallest supported budget is 2,000 tokens. So the fields
are hard-capped (name 60 characters, description 200, instructions 600, note
120) and an overflow is **refused, never silently truncated**: instructions
that quietly lost their second half would degrade exactly when they matter.
The desktop editor shows live counters.

## Consent

Only you can widen what Enio reads. Creating a project, attaching a path and
opening a project are user acts — the CLI or the (authenticated) desktop —
and no tool the model holds can do any of them. Attaching refuses the
filesystem root, your home directory itself, and Enio's own data directory.
The active project is process memory: a restart forgets it, and reopening is
a fresh click or command. Deleting a project removes its folder, index, and
generated files, but never the attached originals, and its conversations stay
in history.

## Resume

Conversations started under a project are tagged with it. `enio project open`
drops you into the project's most recent conversation; the desktop does the
same, and its history dialog can filter to the current project. Launching the
desktop app restores the project you last had **open** — closing one sticks,
so a closed project stays closed across restarts and new chats started after
it are untagged. Opening a conversation that
belongs to a *different* project does not silently switch — the badge naming
its project next to it is the click that does.
