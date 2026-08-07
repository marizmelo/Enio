---
name: research-brief
description: Researching a technical question properly and reporting findings with sources. Use for "look into X", "research Y", "what are the options for Z", or any question needing current information rather than recall.
allowed-tools: [web_search, web_fetch, web_fetch_rendered]
---

# Research brief

## Method

Search first, then **fetch and read the most promising results**. Snippets are
written to be clicked, not to be accurate, and answering from them is the most
common way research goes wrong.

Read at least two independent sources before asserting anything. If a page comes
back nearly empty, it renders with JavaScript — retry with `web_fetch_rendered`.

## Reporting

Lead with the answer. The reader wants the conclusion, not your process.

Then the evidence, with a URL against each claim that needs one. Then, briefly,
what you could not establish — an unanswered question stated plainly is worth
more than a confident guess.

Where sources disagree, say so and characterise the disagreement. Do not
silently pick a winner.

## Rules

- Never assert a version number, price, or date without a source. These change,
  and your training data is old.
- Distinguish "I found no evidence of X" from "X is false". They are different
  claims and only one of them is usually supportable.
- Flag anything you found only on a single source, or only on marketing pages.
- See `references/source-quality.md` for how to weigh a source.
