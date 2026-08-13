---
title: Document library
layout: default
nav_order: 7
---

# The document library

Drop files into `~/enio-workspace/library/` and they become searchable in
chat. Each subfolder you create is a **category**:

```
~/enio-workspace/library/
  research/     papers, articles, reference material
  personal/     leases, records, letters
  admin/        invoices, receipts, forms
```

The folder names are yours to choose — any first-level subfolder is a
category, and files dropped at the root get the category `library`. What
enio writes for you joins the same index automatically: meeting notes and
generated documents land at the workspace root and are searchable under the
category `created`, so "find the action items from Tuesday's meeting" is a
library question too. Then just ask:

> search my library for the apartment lease terms
>
> what does the paper in my research folder say about context windows?

The librarian agent answers with the matching passages and names the file
each one came from. Mention a file with `@` to attach the whole document to
the conversation.

## What gets indexed

Text files of any kind (markdown, plain text, CSV, code…) and **PDFs with a
text layer**. Files are split into small chunks, each embedded for semantic
search, with a keyword index alongside for exact terms — invoice numbers,
names, filenames — that embeddings miss.

Not indexed, on purpose for now: scanned PDFs and images (no text layer —
they would need OCR on every scan), Word/Office files, binaries, and text
files over 512&nbsp;KB. A file that can't be indexed is simply skipped; it
never breaks the scan.

## When it indexes

The library keeps itself fresh — there is nothing to run:

- searching triggers a quick rescan (at most once every 5 seconds), so a file
  you just dropped is found by the very next question;
- the server rescans every 5 minutes in the background, so big drops are
  usually embedded before you ask;
- `enio library scan` forces one from the terminal.

Only new and changed files are re-read. The first scan of a large library
takes a few minutes (a couple hundred documents means a few thousand chunks
to embed); after that it's incremental and near-instant.

```sh
enio library         # what it holds, per category
enio library scan    # index new and changed files now
```

## The files stay the source of truth

The index is a cache derived from the files, never the other way around.
Deleting a file removes it from search on the next scan; `enio reindex`
throws the whole index away and rebuilds it from the folder. Nothing about
your documents lives only inside enio.

If embeddings are unavailable (first run without a network, for instance),
new files are still indexed for keyword search and pick up their embeddings
on a later scan — search degrades, it doesn't break.
