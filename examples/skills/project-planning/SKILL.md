---
name: project-planning
agents: [coder, generalist]
description: Breaking a goal into a plan — milestones, next actions, and open questions. Use when the user wants to plan a project, organise work, decide what to do next, or turn a vague ambition into steps.
allowed-tools: [write_file, read_file, edit_file]
---

# Planning a project

## The shape of a useful plan

Three short sections, in this order:

1. **Milestones** — outcomes, not activities. "Booking flow works end to end",
   not "work on booking flow". Three to five; more means the goal is really
   several goals.
2. **Next actions** — the two or three things that can start *now*, each
   small enough to finish in one sitting, each naming who or what it waits on
   if blocked.
3. **Open questions** — what is genuinely undecided. Never bury a decision
   inside a task ("build X using Y" hides "should we use Y?").

## Keep it in one file

Write the plan to `plan.md` with a plain relative path, so it is stored with
the project. Update the same file on later requests rather than writing
plan-2.md — read it first, change what changed, keep the rest.

## When asked "what should I do next"

Read `plan.md` if it exists. Answer with the single next action, not the
whole plan. If everything in Next actions is blocked, say what unblocks the
most.
