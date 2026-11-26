---
title: Assets
layout: default
nav_order: 6
---

# Assets

An asset is one thing Enio made: a document, a picture, an email draft, or a
whole folder of files such as a small app. Every asset is kept in one place,
in the order it was made, and carries what made it.

## Where they are

```
~/enio-workspace/assets/
  2026-11-25-1624-trails-sintra/
    trails-sintra.md
  2026-11-25-1702-build-tip-calculator/
    index.html
    styles.css
    js/app.js
```

One folder per asset, named by when it was made and what it is. They sort by
date in Finder with nothing open. Everything a single turn creates goes in
the same folder, so an app written as five files is one asset, not five. A
plan or an automation is the same: all of its steps share one folder.

This is true whether or not a project is open. A project is a tag on the
asset, something you can filter by, and not a different place on disk.

## What each one remembers

- **Why it exists:** the request that led to it, in your own words.
- **Who made it:** the agent, or the plan or automation that ran.
- **Which conversation asked,** and which project was open.
- **What it is:** read off the content. A document's first heading, a web
  page's title, an email draft's subject and recipient.

None of that is written by the model. The request is quoted, and the rest is
read from the files, so an asset cannot describe itself as something it is
not.

This record is stored inside the asset's own folder, so it does not depend on
the conversation. **Discard the conversation and the asset stays,** still
saying what was asked and what it is.

## Browsing

The folder icon in the top bar opens **Assets**. The first tab lists
everything Enio has made, newest first, grouped by day. On each row:

- Click it to **open** it. A document opens beside the chat, a picture in
  the viewer, an app's page in your browser.
- **Go to the conversation** that made it. When that conversation has been
  discarded the row says so, and still shows the request.
- **Show in Finder.**
- **Delete** it, in two clicks.

With a project open you can narrow the list to that project.

## Files that live in your own folders

When you attach a folder to a project and ask for code, the code goes into
that folder. Attaching it was the instruction, and "fix app.js" has to change
your file and not a copy of it. Those files still appear in the list, as an
entry that points at where they are. Deleting that entry never deletes
anything from your folder.

A document is not code. In a code project, a document Enio writes is an
asset in the store unless you ask for it by a path inside your folder.

## What came before

Files Enio made before assets existed are listed where they sit: the top of
`~/enio-workspace`, and each project's own folder under `~/.enio/projects/`.
They are not moved, so any path you already use keeps working. Where the
conversation that made one still exists, its origin is recovered from that
conversation's record. Where it does not, the row says its origin is not
known.

Things *you* attach to a conversation are not assets. They are under the
**Attachments** tab, grouped by the conversation you attached them to.

## What is not an asset yet

- **Meeting notes and notes** keep their own panel and their own folder.
- **Files a shell command creates** are not recorded, because Enio sees the
  command and not what it wrote.
