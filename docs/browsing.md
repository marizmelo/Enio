---
title: Browsing
layout: default
nav_order: 8
---

# Browsing

Three ways to reach the web, in increasing order of involvement.

| Tool | For |
|---|---|
| `web_search` | Finding pages. Keyless via a local SearXNG, or Brave/Tavily with a key. |
| `web_fetch` | One page, plain HTML, no session. The quick path. |
| `browse` | Reading a page and following links, keeping the session between calls. |

## `browse`

```
you › what changed in the latest Node release
  → researcher
  ⚒ web_search {"query":"node.js release notes"}
  ⚒ browse {"url":"https://nodejs.org/en/about"}
  ⚒ browse {"link":2}
```

A page comes back as readable text plus its links as a **numbered list**, and
the agent follows one with `link: 7` rather than composing a URL. That is the
same trick as clicking by name: choosing from a short list is something a small
model does reliably; writing a URL from memory is not.

The session persists across calls, so following a trail through a site is one
journey rather than a series of unrelated fetches. Each conversation gets its
own tab, sharing one browser profile — so two conversations never read each
other's pages, while a login would apply everywhere.

**It is read-only.** It navigates and reads; it does not click buttons, submit
forms or type. Those mutate, and mutations belong in the approval sheet.

Page text is labelled as data where it enters the model, and is never edited to
remove instruction-shaped sentences — silently rewriting what a page said would
make the trace a lie. The real defence is that the agent reading it cannot act;
see [Agents and routing](agents).

Local and internal addresses are refused before any request: loopback, private
ranges, and the cloud-metadata address. That guard matters more here than for a
hand-typed fetch, because the URL often comes from a page's own link list.

Needs Playwright:

```sh
npm install playwright && npx playwright install chromium
```

Without it, `browse` isn't offered at all.

## Search without a key

```sh
docker run -d --name searxng -p 8888:8080 searxng/searxng
export SEARXNG_URL=http://localhost:8888
```

Or set a `BRAVE_API_KEY` / `TAVILY_API_KEY` instead.
