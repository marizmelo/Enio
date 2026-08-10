---
title: Home
layout: default
nav_order: 1
---

# Enio

A local AI agent. It runs a model on your own machine and gives it tools, memory
that persists across conversations, and — on a Mac — the ability to actually do
things in your apps.

No API keys. No account. Nothing leaves your computer.

---

## Start here

| | |
|---|---|
| [Getting started](getting-started) | Install it, run it, grant the permissions |
| [Chatting](chatting) | The conversation loop, `/skill`, `@mention`, commands |
| [Controlling your Mac](mac-control) | Open apps, read windows, propose and approve plans |
| [Models](models) | Switching models, and what the context budget means |

## Everything else

| | |
|---|---|
| [Memory](memory) | Facts, preferences, examples, and the knowledge graph |
| [Agents and routing](agents) | Why there are six specialists and how one gets picked |
| [Browsing](browsing) | Reading the web as a session |
| [Skills](skills) | Teaching it know-how, in markdown, with no code |
| [Scheduled tasks](tasks) | Cron-driven runs through the ordinary turn path |
| [MCP servers](mcp) | Adding third-party tools |
| [Configuration](configuration) | Every environment variable |
| [Remote access](remote-access) | Reaching it from a phone or another network |
| [Troubleshooting](troubleshooting) | When something does not work |

---

## What makes it different

**One constraint drives the design: the model is small.** Enio's default runs
about 1B active parameters. A model that size picks tools badly once it can see
more than a handful, writes malformed JSON often enough that repair is a normal
path, and is far better at *choosing from a short list* than at generating
freely.

So nearly everything here turns generation into selection. The router picks one
of six specialists, each with at most six tools. Clicking is done by *name* read
from the accessibility tree, never by pixel coordinate. Memory extraction uses a
closed vocabulary of nine relations. Recipes are tested scripts the model
selects rather than writes.

**Nothing irreversible happens without you.** The model proposes; a person
approves. It can read your calendar without asking and cannot send an email
without a flag being set. When it wants to do something new on your Mac it
writes down the exact script and stops — you read it, edit it if you like, test
a single step, and only then does anything run.

**It degrades rather than fails.** No vision model falls back to OCR, no OCR
falls back to image dimensions, no embeddings falls back to keyword matching. A
tool that cannot work is withheld entirely rather than offered and failing,
because a dead end costs the model attention it does not have to spare.
