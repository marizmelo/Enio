---
title: Skills
layout: default
nav_order: 13
---

# Skills

A skill is **know-how**, written in markdown, with no code.

The distinction that matters: *MCP gives a model new capability; a skill gives
it know-how.* A tool lets it send email; a skill tells it how **you** want
emails written. People reach for MCP when what they needed was a skill, get
something generic, and then re-explain their preferences every time.

Four skills cost about 230 tokens of prompt, measured. The same thing via MCP
would cost a tool slot per server against a sixteen-tool ceiling.

## Writing one

```sh
enio skills-new commit-message
enio skills                     # what is installed
```

Your own skills live in `~/.enio/skills/<name>/SKILL.md`:

```markdown
---
name: commit-message
description: How to write a commit message for this project
---

Record the constraint, the alternative rejected, and the failure it prevents.
The diff already shows what changed.

Never mention tooling or assistance in the message.
```

The `description` is what the model reads to decide whether the skill applies,
so write it as the situation it covers, not as a title.

## Bundled skills, and your own

Enio ships with a handful of skills (commit messages, weekly review, research
briefs, previewing a page locally, and so on). They are **read from the installation itself**, not copied
into your folder — so `git pull` brings improvements to them with it. The
panel marks them **built-in**.

Editing one makes it yours: the first save writes a copy into
`~/.enio/skills/<name>/`, which takes precedence from then on, and the row
reads **yours · replaces built-in**. That copy is now your document — it will
not change under you, which also means later improvements to the bundled
version stop reaching it. **Reset** on that row deletes your copy and puts the
bundled one back in front; it is refused when there is no bundled version
behind it, so it can never remove the only copy of a skill.

If you installed enio before this and have unmodified copies of the bundled
skills sitting in your folder, `enio skills --tidy` removes exactly those —
the ones byte-identical to what ships — so they start tracking updates again.
Anything you edited is left alone.

## Progressive disclosure

Only the name and description of each skill sit in the prompt. The body is
fetched with `read_skill` when the model decides it is relevant — so installing
many skills costs a catalogue line each, not their full text.

Invoking one explicitly with `/commit-message` skips that decision and injects
the body whole. Asking for it by name is unambiguous; making the model call a
tool to fetch what you just named would put the decision straight back.

Set `disable-model-invocation: true` in the front matter to keep a skill out of
the catalogue entirely — it then runs only when you name it.

## The Skills panel

Skills have a visible home in the desktop app: the **Skills** button in the
status bar, beside Automations. Those two are the whole of "things that
repeat" — an automation *runs*, a skill *informs* — and saved
[computer scripts](mac-control.md) live inside Automations, with the things
that act. Each row shows the
skill, where it lives (a *project* badge for project-local ones, *manual* for
`disable-model-invocation`), and — the part no file listing can show —
**whether it gets used**: how many conversations reached for it and when the
last one was. A skill that has sat unused for months is either badly described
or no longer needed, and this is where you find out.

Two more things surface there. A skill whose SKILL.md fails to parse appears
as a broken row with the reason, instead of silently dropping out of the
catalogue. And when the model asks for a skill that doesn't exist, the name it
asked for is listed — the model reaching for `meeting-notes` three times is a
strong hint about what to write next.

**Click a skill to edit it.** The editor opens in the panel itself — the same
one the agent's documents use, with Preview, ⌘S, and the selection verbs
(*Tighten*, *Expand*, *Rewrite…*, *Continue*) — and **← All skills** goes
back. It stays inside this window rather than pinning beside the
conversation, because a skill is configuration: there is no chat to iterate
against. Edits apply on the next message; nothing to reload. A broken skill
opens the same way, which is the point: the row tells you what is wrong and
the click takes you to where you fix it.

**A save that would break the skill is refused, not stored.** A skill's
identity lives in the `---` block at the top, and a mangled one silently
drops out of the catalogue — so the save runs the same parse the loader does
and rejects anything it would not accept, naming the reason. Same rule as
saving a recipe, which runs the script first.

The panel does not create or delete: a skill is a folder you own, so
**Show in Finder** takes you to it (that is also where its `references/` and
`scripts/` live), and any external editor works exactly as before.

## Finding what to write

The usual way automation gets built is deciding in advance what *ought* to be
repetitive, and being wrong. Enio records every turn, so the question is
answerable from evidence:

```sh
enio suggest            # what you have actually repeated
enio suggest --write    # scaffold SKILL.md drafts from it
```

It looks for clusters of near-identical questions (you have been re-explaining
something), repeated tool sequences (a procedure, whether or not you think of it
as one), and corrections you keep making.
