---
title: Browsing
layout: default
nav_order: 8
---

# Browsing

Three ways to reach the web, in increasing order of involvement.

| Tool | For |
|---|---|
| `web_search` | Finding pages *and reading the top few*. Works with no setup. |
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
see [Agents and routing](agents.md).

One structural exception is edited: chat-template control tokens. A page
containing the literal `<|im_start|>` could otherwise forge a conversation-turn
boundary — an attack no "this is data" label stops, because it happens below the
level the model reasons about. Those tokens are neutralised in place
(`<|im_start|>` becomes `⟨im_start⟩`) in every page, file and OCR result before
the model sees it: the words and the token's name stay, only the exact string
the tokenizer treats as special is gone.

Local and internal addresses are refused before any request: loopback, private
ranges, and the cloud-metadata address. That guard matters more here than for a
hand-typed fetch, because the URL often comes from a page's own link list.

Needs Playwright:

```sh
npm install playwright && npx playwright install chromium
```

Without it, `browse` isn't offered at all.

## Search

`web_search` returns the ranked list **and the text of the top three results**,
in one call. The intended sequence is search, then fetch the best hit — and a
small model reliably stops after the first step and writes a summary of the
search snippets, which reads like an answer and is assembled from search-engine
blurbs. Doing the second step for it removes a decision it gets wrong. Page text
is clipped hard, because the context budget is small.

Pages that return 404 are refused rather than read. A browser renders an error
page exactly as happily as an article, so without checking the status the model
reads "Page Not Found" as content and reasons from it.

**Search works out of the box.** With nothing configured, `web_search` uses
DuckDuckGo's HTML-only endpoint — the page it serves to clients that cannot run
JavaScript. Plain HTML over a plain fetch, no browser, no key, no container.
Sponsored rows are dropped before the model sees them: an advert handed to a
model as a result is an advert it will summarise as a recommendation.

That is last in the order, not first. Anything configured wins:

| Order | Provider | Set |
|---|---|---|
| 1 | SearXNG | `SEARXNG_URL` |
| 2 | Brave | `BRAVE_API_KEY` |
| 3 | Tavily | `TAVILY_API_KEY` |
| 4 | DuckDuckGo | nothing — the default |

```sh
docker run -d --name searxng -p 8888:8080 searxng/searxng
export SEARXNG_URL=http://localhost:8888
```

SearXNG is still the one to run if you search a lot. It aggregates ~70 engines
behind one local API and absorbs the maintenance burden of engines changing
their markup — which is exactly the burden the DuckDuckGo path carries itself.

**Why have the fragile one at all?** Because the alternative was worse. With no
key and no Docker, `web_search` used to be withheld entirely, which left the
model reaching for `web_fetch` and `browse` — and that means *guessing a URL*. A
4B model guessing `cnet.com/best-products/best-bluetooth-speakers-under-150-dollars`,
landing on a 404 and reporting that no such page exists is the failure this
removes. A search that occasionally breaks beats a URL that is always a guess,
and when it does break the result is one provider returning nothing rather than
a confident wrong answer.

Scraping Google or Bing is still not offered. They actively defend against it
and a headless browser only delays the breakage.
