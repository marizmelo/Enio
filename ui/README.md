# enio inspector

A read-and-manage UI for enio's conversation history and knowledge graph.
Plain React + `@xyflow/react`, bundled to a single JS file with esbuild — no
dev server, no framework runtime beyond React. The enio Node backend serves
`ui/dist/` as static files and the API under `/api/*` on the same origin.

## Build

```sh
cd ui
npm install
npm run build
```

This runs `build.mjs`, which calls esbuild's JS API directly (no CLI, no
webpack, no vite) and produces:

```
ui/dist/index.html   the HTML shell
ui/dist/bundle.js     React + ReactFlow + app code, bundled and minified (~390 KiB)
ui/dist/bundle.css    all CSS (app styles + @xyflow/react's stylesheet), ~28 KiB
```

Target is `es2020`. There's no watch mode — re-run `npm run build` after
changing anything in `src/`.

## Serving it

The backend should serve everything under `ui/dist/` at `/`, and answer
`/api/*` on the same origin (the app calls relative URLs like
`/api/sessions`, so origin, port, and TLS all just need to match whatever
serves the HTML).

### Auth

Every `/api/*` call needs `Authorization: Bearer <token>`. The frontend
reads the token from `window.__ENIO_TOKEN__`, which the **backend** must set
by injecting a small inline script into `index.html` before `bundle.js`
loads, e.g.:

```html
<script>window.__ENIO_TOKEN__="the-token-here";</script>
```

`ui/dist/index.html` ships with a fallback that defines
`window.__ENIO_TOKEN__ = ""` if nothing injected it, so the app still boots
(and shows a clear "not authorized" state on the first API call) instead of
crashing on a missing global. The single fetch helper that attaches this
header and turns a 401 into a readable error lives in `src/api.js`
(`apiFetch`).

## Views

The app has two tabs, `Runs` (default) and `Graph`. A slim header bar always
shows live counts from `GET /api/stats` (sessions, turns, messages, facts,
entities, edges).

### Runs

The point of this view is spotting when the model's tool-calling output had
to be salvaged, and seeing exactly what memory was injected into a given
answer.

- **Left**: session list (`GET /api/sessions`) — relative time, turn count,
  and a summary snippet. Click one to load its turns.
- **Right**: a vertical timeline of that session's turns
  (`GET /api/sessions/:id/turns`). Each turn card shows:
  - The question and a colored chip for the specialist that handled it
    (researcher / coder / librarian / generalist / unrouted).
  - Duration and iteration count, plus aggregate badges if any step in the
    turn was `repaired` or `scavenged`, so a flagged turn is visible without
    opening anything.
  - A **System prompt** panel — collapsed by default — showing the exact
    prompt sent for that turn, with the `<memory>` block visually
    highlighted (a tinted, bordered inline span) so it's immediately obvious
    what memory was injected into that specific answer. This is built to be
    the most useful part of the UI.
  - A **Steps** panel with every step in order. Tool steps show the tool
    name, formatted (pretty-printed) arguments, and the result; model steps
    show reasoning (`<think>` content) and raw text. Each field truncates
    long text with a "Show all" toggle rather than dumping walls of text
    inline. Any step with `repaired` or `scavenged` set gets its own visible
    warning badge — repaired (JSON needed fixing) is a caution color,
    scavenged (tool call recovered from plain prose) is the danger color,
    since it's the stronger signal the model failed to follow the calling
    convention at all.
  - The reply.
- **Filters**: a checkbox to show only turns containing a repaired/scavenged
  step, and a specialist dropdown, both applied client-side against the
  currently loaded session's turns.

### Graph

`GET /api/graph?limit=300` renders as a ReactFlow canvas.

- Node color encodes entity `type` (person / project / technology /
  organization / place / concept — anything else falls back to a neutral
  gray); node size scales with `mentions` on a log curve so one
  heavily-mentioned entity doesn't dominate the canvas.
- Edge label is the `relation`; both stroke width and opacity scale with
  `confidence` (edges with a missing/null confidence are always shown, since
  "unknown" shouldn't read as "low").
- **Layout**: ReactFlow has no built-in force layout and this intentionally
  does not add d3 as a dependency. `src/forceLayout.js` is a small
  (~100-line) Fruchterman-Reingold-style simulation — pairwise repulsion,
  spring attraction along edges, mild centering gravity, 200 iterations with
  cooling — computed once per fetched dataset (keyed on the sorted node/edge
  ids) and cached, so positions stay stable across re-renders, filtering, and
  selection. Initial placement uses a seeded PRNG rather than `Math.random`,
  so the same graph lays out the same way every time it's computed.
- Click a node to open a right-hand side panel with its details and every
  edge touching it (direction, the entity on the other end, confidence),
  each with its own delete button. A "Delete entity" action at the bottom
  cascades to that entity's edges, per the API contract.
- Click an edge for a confirm prompt, then `DELETE /api/graph/edges/:id`;
  deleted edges are removed from the view immediately without a refetch.
- A confidence slider filters out edges below the threshold (nodes stay
  put — only edges are hidden).
- A search box highlights matching nodes (a glow/ring around the node) and
  recenters the canvas on the first match.
- Empty state (no nodes returned) explains that the graph fills in once
  conversations are indexed into memory — it doesn't show a bare blank
  canvas.

## Design

Dark theme by default; `prefers-color-scheme: light` is fully supported via
a parallel set of CSS custom properties in `src/styles.css` — no
theme-switching JS. System font stack for UI text, monospace
(`ui-monospace`/`SF Mono`/`Menlo`/`Consolas`) for prompts, tool
arguments/output, and raw model content. One accent hue, 7–10px radii, no
heavy shadows, borders instead of drop shadows for separation.

## Handling flaky/missing data

The backend is fed by a small local model, so the UI treats every documented
"may be null" field as actually null sometimes, and treats fields *not*
documented as nullable defensively too:

- `src/utils.js` has null-safe formatters for relative time, duration, JSON
  pretty-printing (falls back to the raw string if `JSON.parse` throws), and
  entity/specialist color lookups that fall back to a neutral color for
  unrecognized values.
- List responses (`sessions`, `turns`, `steps`, graph `nodes`/`edges`) are
  defensively coerced to arrays and filtered for null/non-object entries
  before rendering.
- Every fetch (`src/api.js`) surfaces network failures, non-2xx statuses,
  and invalid JSON as a distinct, readable `ApiError` rather than an
  unhandled rejection; 401s specifically bubble up to a global banner
  telling the user to reload the page for a fresh token.
- Long tool output / raw content / replies truncate by default with a
  "Show all (N chars)" toggle (`src/components/Expandable.jsx`) instead of
  rendering unbounded text inline.
- Sessions, turns, and the graph each have their own empty state instead of
  rendering blank panels.

## What's intentionally not here

- No client-side router — two tabs, one page, `useState`.
- No state management library — a handful of `useState`/`useMemo` per view
  is enough at this scale.
- No d3 — see the force layout note above.
- No dev server — this is a static build the backend serves; there's
  nothing to hot-reload in production, and `npm run build` is fast enough to
  rerun by hand while iterating.
