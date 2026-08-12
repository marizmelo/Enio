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
instructions, and open it. The chip shows which project is active, because an
open project quietly shapes every turn.

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

## Search

The coder has a `search_code` tool: query in, ranked `path:line` locations
out. It is deterministic — SQLite full-text search over the attached folders
plus live ripgrep, no embeddings — and its index lives inside the project
folder, refreshed incrementally. In a git repository it indexes what
`git ls-files` reports, so `.gitignore`d build output and `.env` secrets stay
out. Oversized and binary files are skipped. Without a project open it
searches the workspace.

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
desktop app restores your last conversation *with its project* — the thread
comes back as you left it, scope included. Opening a conversation that
belongs to a *different* project does not silently switch — the badge naming
its project next to it is the click that does.
