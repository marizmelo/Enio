---
name: commit-message
description: Writing a git commit message, or reviewing staged changes before committing. Use whenever the user is about to commit, asks for a commit message, or says "commit this".
allowed-tools: [run_command, read_file]
---

# Writing a commit message

## Read the change first

Never write a message from the file names alone. Run `git diff --staged` and
read it. If nothing is staged, run `git diff` and say so — you are describing
uncommitted work, not a commit.

## What the message must contain

A subject line under 72 characters, in the imperative mood: "Add retry to the
upload path", not "Added" or "Adds".

Then a blank line, then the part that matters: **why**. The diff already shows
what changed — anyone can read it. What they cannot recover six months later is
the reasoning, the alternative you rejected, and the constraint that forced it.

Bad:
```
Update config handling
```

Good:
```
Read ENIO_* with a MAPLE_* fallback

The project was renamed, and anyone with the old variables in a shell
profile would otherwise have their config silently revert to defaults.
A value that quietly reverts is worse than one that errors.
```

## Rules

- One logical change per commit. If the diff does two unrelated things, say so
  and suggest splitting it rather than writing a message that hides the seam.
- No "various fixes", "cleanup", "misc", or "wip" as a final message.
- Mention the failure the change prevents, if there is one.
- Do not describe the mechanics of the diff line by line.
- If the change is genuinely trivial — a typo, a version bump — a subject line
  alone is correct. Do not pad it.

## Before you finish

Show the message and ask for confirmation. Do not run `git commit` unless the
user asked you to commit, as opposed to asking for a message.
