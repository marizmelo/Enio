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
