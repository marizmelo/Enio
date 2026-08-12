---
name: delegate-coding
description: Delegating a large or complex coding task to a frontier coding CLI (Claude Code or Gemini CLI) installed on this machine. Use when a change spans many files, needs deep refactoring, or has resisted two attempts here.
allowed-tools: [run_command, read_file, search_code]
---

# Delegating to a coding CLI

This machine may have a frontier coding agent installed — `claude` (Claude
Code) or `gemini` (Gemini CLI). They are far stronger at multi-file changes
than a local model, and a repo containing `AGENTS.md` or `CLAUDE.md` was set
up with them in mind. Orchestrate; don't compete.

## Check availability first

Neither binary is in the allowed command list until the user adds it:

```
ENIO_EXTRA_COMMANDS=claude,gemini
```

If `claude --version` is refused, say so and tell the user about that setting
rather than retrying.

## How to delegate

Run non-interactively, with a single, complete instruction:

```
claude -p "Fix the failing test in src/parser.test.ts; run npm test to verify"
```

```
gemini -p "Rename UserStore to AccountStore across this package"
```

Run from the folder the work is in (use the `in` parameter of run_command to
pick the attached folder). Give one task per invocation, name the files you
already located with search_code, and state how to verify.

## After it returns

Read the output. Check the change yourself — run the test or build it names.
Report what the delegate did and what you verified, as separate things.
