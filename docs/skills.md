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

Skills live in `~/.enio/skills/<name>/SKILL.md`:

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

## Progressive disclosure

Only the name and description of each skill sit in the prompt. The body is
fetched with `read_skill` when the model decides it is relevant — so installing
many skills costs a catalogue line each, not their full text.

Invoking one explicitly with `/commit-message` skips that decision and injects
the body whole. Asking for it by name is unambiguous; making the model call a
tool to fetch what you just named would put the decision straight back.

Set `disable-model-invocation: true` in the front matter to keep a skill out of
the catalogue entirely — it then runs only when you name it.

## The Skills tab

Skills have a visible home in the desktop app: the **Skills** tab, next to
your automations (the workflow button in the top bar). Each row shows the
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

The tab is read-only on purpose: a skill is a folder of markdown you own.
**Show in Finder** on any row takes you to it, and edits apply on the next
message — nothing to reload.

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
