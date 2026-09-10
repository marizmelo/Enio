/**
 * Training scenarios for the coder specialist's adapter.
 *
 * Each scenario is one conversation demonstrating the *form* the adapter
 * exists to teach: pick the right tool among six, emit arguments as valid
 * JSON, read before editing, write files instead of narrating code, stay
 * coherent across several tool calls, stop when the task is done. Facts are
 * deliberately absent — retrieval owns facts; the adapter owns form
 * (see DECISIONS.md on learning without training).
 *
 * Tool-result strings mirror the real tools' output shapes (read_file's
 * `   N | ` gutter, search_code's `path:line:`, write_file's `Wrote N
 * bytes`), because the model must learn to act on what those tools actually
 * print — a training result in a shape the tool never produces teaches a
 * reflex serving never triggers.
 *
 * Everything stays short on purpose: max_seq_length caps what the trainer
 * sees, and a scenario that gets truncated mid-conversation trains the model
 * to stop mid-task.
 */

import {
  call,
  result,
  say,
  user,
  numbered,
  wrote,
  recoveryScenarios,
  goldenRecovery,
  goldenAbstain,
} from "./lib.mjs";

/* ------------------------------------------------------------------ */
/* Family A: create a file — code goes in files, never in the reply.  */

const CREATE = [
  {
    ask: "write a python script that renames every .jpeg file in a folder to .jpg",
    path: "rename_jpeg.py",
    content: `import sys
from pathlib import Path

folder = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
for f in folder.glob("*.jpeg"):
    f.rename(f.with_suffix(".jpg"))
    print(f"renamed {f.name}")
`,
    done: "Wrote rename_jpeg.py. Run it with `python rename_jpeg.py <folder>`; it defaults to the current directory.",
  },
  {
    ask: "make me a bash script that backs up my notes folder to a dated tarball",
    path: "backup_notes.sh",
    content: `#!/bin/bash
set -euo pipefail
SRC="$HOME/notes"
OUT="$HOME/backups/notes-$(date +%Y-%m-%d).tar.gz"
mkdir -p "$(dirname "$OUT")"
tar -czf "$OUT" -C "$SRC" .
echo "backed up to $OUT"
`,
    done: "Wrote backup_notes.sh. Make it executable with `chmod +x backup_notes.sh` and it will write dated tarballs into ~/backups.",
  },
  {
    ask: "create a small node script that counts lines in every .js file here",
    path: "count_lines.js",
    content: `const { readdirSync, readFileSync } = require("node:fs");

let total = 0;
for (const f of readdirSync(".")) {
  if (!f.endsWith(".js")) continue;
  const lines = readFileSync(f, "utf8").split("\\n").length;
  console.log(f, lines);
  total += lines;
}
console.log("total", total);
`,
    done: "Wrote count_lines.js — run `node count_lines.js` in the folder you want counted.",
  },
  {
    ask: "write a python script that fetches a url and prints the http status",
    path: "check_url.py",
    content: `import sys
import urllib.request

url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=10) as r:
        print(url, r.status)
except Exception as e:
    print(url, "error:", e)
`,
    done: "Wrote check_url.py. Usage: `python check_url.py https://example.com`.",
  },
  {
    ask: "make a .gitignore for a python project",
    path: ".gitignore",
    content: `__pycache__/
*.pyc
.venv/
venv/
dist/
build/
*.egg-info/
.env
.DS_Store
`,
    done: "Wrote .gitignore with the usual Python entries: bytecode, virtualenvs, build output, and local env files.",
  },
  {
    ask: "create an html page with a centered hello world heading",
    path: "hello.html",
    content: `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Hello</title>
<style>
  body { display: grid; place-items: center; min-height: 100vh; margin: 0; font-family: sans-serif; }
</style>
</head>
<body>
<h1>Hello, world</h1>
</body>
</html>
`,
    done: "Wrote hello.html — open it in a browser to see the centered heading.",
  },
].map(({ ask, path, content, done }) => () => [
  user(ask),
  call("write_file", { path, content }),
  result(wrote(path, content)),
  say(done),
]);

/* ------------------------------------------------------------------ */
/* Family B: documents are files too — write markdown, say where.     */

const DOCUMENT = [
  {
    ask: "write me a short cover letter for a barista job at a local cafe",
    path: "cover-letter.md",
    content: `# Cover Letter

Dear Hiring Manager,

I would love to join your team as a barista. I enjoy the pace of cafe work,
I learn drink builds quickly, and I care about regulars leaving happier than
they arrived. I am reliable on early shifts and comfortable on register.

I would welcome the chance to talk.

Sincerely,
[Your name]
`,
    done: "Saved the letter to cover-letter.md — edit the bracketed name and any details you want to personalize.",
  },
  {
    ask: "draft a one page plan for cleaning up our project backlog",
    path: "backlog-cleanup-plan.md",
    content: `# Backlog Cleanup Plan

## Goal
Reduce the backlog to items we would actually schedule.

## Steps
1. Close anything untouched for six months — reopening is cheap.
2. Merge duplicates; keep the ticket with the better description.
3. Label what remains: bug, feature, chore.
4. Rank the top ten as the only ordered list we maintain.

## Cadence
Thirty minutes, once a week, until done.
`,
    done: "Saved the plan to backlog-cleanup-plan.md.",
  },
  {
    ask: "write meeting notes: we decided to ship friday, alice owns the changelog, bob owns the deploy",
    path: "meeting-notes.md",
    content: `# Meeting Notes

## Decisions
- Ship on Friday.

## Owners
- Changelog: Alice
- Deploy: Bob
`,
    done: "Saved to meeting-notes.md.",
  },
  {
    ask: "make a checklist for onboarding a new teammate",
    path: "onboarding-checklist.md",
    content: `# Onboarding Checklist

- [ ] Accounts: email, chat, repo access
- [ ] Dev setup: clone, install, run the tests
- [ ] Read the project README and architecture notes
- [ ] Pair on one small fix in week one
- [ ] Ship something user-visible in month one
`,
    done: "Saved the checklist to onboarding-checklist.md.",
  },
].map(({ ask, path, content, done }) => () => [
  user(ask),
  call("write_file", { path, content }),
  result(wrote(path, content)),
  say(done),
]);

/* ------------------------------------------------------------------ */
/* Family C: look before you edit — read_file, then edit_file with    */
/* old_string copied exactly, WITHOUT the gutter.                     */

const EDIT = [
  {
    ask: "change the port in server.py from 8000 to 3000",
    path: "server.py",
    file: `import http.server

PORT = 8000

handler = http.server.SimpleHTTPRequestHandler
with http.server.HTTPServer(("", PORT), handler) as httpd:
    print("serving on", PORT)
    httpd.serve_forever()`,
    old: "PORT = 8000",
    new: "PORT = 3000",
    done: "Changed PORT from 8000 to 3000 in server.py.",
  },
  {
    ask: "the greeting in app.js should say Good morning instead of Hello",
    path: "app.js",
    file: `function greet(name) {
  return "Hello, " + name + "!";
}

module.exports = { greet };`,
    old: 'return "Hello, " + name + "!";',
    new: 'return "Good morning, " + name + "!";',
    done: "Updated the greeting in app.js to say Good morning.",
  },
  {
    ask: "bump the version in package.json to 1.3.0",
    path: "package.json",
    file: `{
  "name": "acme-tool",
  "version": "1.2.4",
  "main": "index.js"
}`,
    old: '"version": "1.2.4",',
    new: '"version": "1.3.0",',
    done: "Bumped the version in package.json from 1.2.4 to 1.3.0.",
  },
  {
    ask: "in config.yaml set debug to false",
    path: "config.yaml",
    file: `app: acme
debug: true
log_level: info
retries: 3`,
    old: "debug: true",
    new: "debug: false",
    done: "Set debug to false in config.yaml.",
  },
  {
    ask: "rename the function calc to calculate_total in billing.py",
    path: "billing.py",
    file: `def calc(items):
    return sum(i["price"] * i["qty"] for i in items)


def receipt(items):
    return f"total: {calc(items)}"`,
    old: "def calc(items):",
    new: "def calculate_total(items):",
    second: {
      old: 'return f"total: {calc(items)}"',
      new: 'return f"total: {calculate_total(items)}"',
    },
    done: "Renamed calc to calculate_total in billing.py, including its call site in receipt().",
  },
  {
    // The observed expensive failure: asked to ADD to an existing file, the
    // model rewrote it whole with write_file and 619 lines vanished. A
    // feature request against an existing file starts with read_file and
    // lands as edits — write_file is for files that do not exist yet.
    ask: "add a clear-completed button to my todo app in app.js",
    path: "app.js",
    file: `const list = document.getElementById("list");
const input = document.getElementById("input");

function addTodo(text) {
  const li = document.createElement("li");
  li.textContent = text;
  li.onclick = () => li.classList.toggle("done");
  list.appendChild(li);
}

input.onkeydown = (e) => {
  if (e.key === "Enter" && input.value.trim()) {
    addTodo(input.value.trim());
    input.value = "";
  }
};`,
    old: `input.onkeydown = (e) => {`,
    new: `function clearCompleted() {
  for (const li of [...list.children]) {
    if (li.classList.contains("done")) li.remove();
  }
}

const clearBtn = document.createElement("button");
clearBtn.textContent = "Clear completed";
clearBtn.onclick = clearCompleted;
list.after(clearBtn);

input.onkeydown = (e) => {`,
    done:
      "Added a Clear completed button to app.js — it removes every todo marked done. The rest of the file is untouched.",
  },
].map(({ ask, path, file, old, new: neu, second, done }) => () => {
  const steps = [
    user(ask),
    call("read_file", { path }),
    result(numbered(file)),
    call("edit_file", { path, old_string: old, new_string: neu }),
    result(`Edited ${path}.`),
  ];
  if (second) {
    steps.push(
      call("edit_file", { path, old_string: second.old, new_string: second.new }),
      result(`Edited ${path}.`),
    );
  }
  steps.push(say(done));
  return steps;
});

/* ------------------------------------------------------------------ */
/* Family D: run, read the failure, fix, run again — the loop that    */
/* falls apart after three calls is exactly what gets rehearsed here. */

const DEBUG = [
  () => [
    user("run the tests and fix whatever is broken"),
    call("run_command", { command: "npm test" }),
    result(
      `> acme@1.0.0 test
> node --test

✖ adds two numbers
  AssertionError: Expected 5, got 4
    at test/math.test.js:6
ℹ tests 3
ℹ pass 2
ℹ fail 1`,
    ),
    call("read_file", { path: "src/math.js" }),
    result(
      numbered(`function add(a, b) {
  return a + b - 1;
}

module.exports = { add };`),
    ),
    call("edit_file", {
      path: "src/math.js",
      old_string: "return a + b - 1;",
      new_string: "return a + b;",
    }),
    result("Edited src/math.js."),
    call("run_command", { command: "npm test" }),
    result(`ℹ tests 3
ℹ pass 3
ℹ fail 0`),
    say(
      "Fixed. add() in src/math.js was subtracting 1 from the sum; removed that and all 3 tests pass now.",
    ),
  ],
  () => [
    user("why does my script crash when I run it?"),
    call("run_command", { command: "python report.py" }),
    result(
      `Traceback (most recent call last):
  File "report.py", line 4, in <module>
    total = sum(row["amount"] for row in rows)
KeyError: 'amount'`,
    ),
    call("read_file", { path: "report.py" }),
    result(
      numbered(`rows = [
    {"amt": 10},
    {"amt": 25},
]
total = sum(row["amount"] for row in rows)
print("total:", total)`),
    ),
    call("edit_file", {
      path: "report.py",
      old_string: 'total = sum(row["amount"] for row in rows)',
      new_string: 'total = sum(row["amt"] for row in rows)',
    }),
    result("Edited report.py."),
    call("run_command", { command: "python report.py" }),
    result("total: 35"),
    say(
      'The rows use the key "amt" but the sum looked up "amount". Fixed the lookup in report.py; it now prints total: 35.',
    ),
  ],
  () => [
    user("check if the project builds"),
    call("run_command", { command: "npm run build" }),
    result(`> acme@1.0.0 build
> tsc

src/index.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'.`),
    call("read_file", { path: "src/index.ts" }),
    result(
      numbered(`export function retries(): number {
  const raw = process.env.RETRIES ?? "3";
  return raw;
}`),
    ),
    call("edit_file", {
      path: "src/index.ts",
      old_string: "  return raw;",
      new_string: "  return Number(raw);",
    }),
    result("Edited src/index.ts."),
    call("run_command", { command: "npm run build" }),
    result(`> acme@1.0.0 build
> tsc`),
    say(
      "It builds now. retries() was returning the raw env string where a number was declared; wrapping it in Number() fixed the type error.",
    ),
  ],
  () => [
    user("run the linter"),
    call("run_command", { command: "npm run lint" }),
    result(`> acme@1.0.0 lint
> eslint src

✔ no problems found`),
    say("Lint is clean — no problems found."),
  ],
  () => [
    user("what does git status say?"),
    call("run_command", { command: "git status --short" }),
    result(` M src/app.js
?? notes.txt`),
    say("One modified file (src/app.js) and one untracked file (notes.txt). Nothing is staged."),
  ],
].map((f) => f);

/* ------------------------------------------------------------------ */
/* Family E: find it first — search_code, read the hit, answer with   */
/* the location rather than a guess.                                  */

const SEARCH = [
  () => [
    user("where is the retry logic?"),
    call("search_code", { query: "retry" }),
    result(`Matches in the workspace (path:line):
src/http.js:41: for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
src/http.js:12: const MAX_RETRIES = 3;`),
    call("read_file", { path: "src/http.js" }),
    result(
      numbered(`const MAX_RETRIES = 3;

async function fetchWithRetry(url) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fetch(url);
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
    }
  }
}`),
    ),
    say(
      "The retry logic lives in src/http.js: fetchWithRetry() loops up to MAX_RETRIES (3, defined at the top of the file) and rethrows the last error when attempts run out.",
    ),
  ],
  () => [
    user("which file defines the database connection?"),
    call("search_code", { query: "database connection" }),
    result(`Matches in the workspace (path:line):
src/db.py:8: # The single database connection for the app.
src/db.py:9: conn = sqlite3.connect(DB_PATH)`),
    say(
      "src/db.py — it creates the app's single sqlite connection (conn) at line 9, from DB_PATH.",
    ),
  ],
  () => [
    user("do we log anywhere when a user signs in?"),
    call("search_code", { query: "sign in log" }),
    result(`Matches in the workspace (path:line):
src/auth.js:57: logger.info("user signed in", { userId });`),
    say(
      'Yes — src/auth.js:57 logs "user signed in" with the userId whenever sign-in succeeds.',
    ),
  ],
].map((f) => f);

/* ------------------------------------------------------------------ */
/* Family F: no tool at all — a question answered is a task done.     */
/* Teaches restraint: not every coder turn needs a call.              */

const DIRECT = [
  () => [
    user("what's the difference between let and const in javascript?"),
    say(
      "const declares a binding that cannot be reassigned; let declares one that can. Both are block-scoped. Note const does not freeze the value — a const array can still be mutated, you just cannot point the name at a different array.",
    ),
  ],
  () => [
    user("explain what a python virtual environment is in one paragraph"),
    say(
      "A virtual environment is a private copy of the Python interpreter's package space for one project. Activating it makes pip install into the project's own folder instead of the system, so different projects can hold different versions of the same library without conflicts.",
    ),
  ],
  () => [
    user("is it better to store config in env vars or a file?"),
    say(
      "Both are fine; the split that works is: secrets and per-machine values in environment variables, and everything shareable in a checked-in config file with sane defaults. Env vars override the file, and nothing secret is committed.",
    ),
  ],
].map((f) => f);

/* ------------------------------------------------------------------ */
/* Family G: dead ends — a tool result the happy path never shows.    */
/* The trained form is bounded: report plainly, or one recovery step, */
/* never a loop of diagnostic variations (the observed live failure). */

const ERRORS = recoveryScenarios([
  {
    ask: "is the git working tree clean?",
    call: ["run_command", { command: "git status --short" }],
    error: "fatal: not a git repository (or any of the parent directories): .git",
    reply:
      "This folder is not a git repository, so there is no working tree to check. If you meant a different folder, tell me which one.",
  },
  {
    ask: "run the python tests",
    call: ["run_command", { command: "pytest" }],
    error: "zsh: command not found: pytest",
    reply:
      "pytest is not installed here, so I could not run the tests. Installing it (`pip install pytest`) or telling me the project's actual test command would get me unstuck.",
  },
  {
    ask: "what does the changelog say?",
    call: ["read_file", { path: "CHANGELOG.md" }],
    error: 'Error: no file at CHANGELOG.md. Did you mean "docs/CHANGELOG.md"?',
    recover: {
      call: ["read_file", { path: "docs/CHANGELOG.md" }],
      output: numbered(`# Changelog

## 0.2.0
- Added export to CSV.

## 0.1.0
- Initial release.`),
    },
    reply:
      "The changelog lives at docs/CHANGELOG.md: version 0.2.0 added CSV export, and 0.1.0 was the initial release.",
  },
  {
    ask: "show me the config file",
    call: ["read_file", { path: "config.toml" }],
    error: "Error: no file at config.toml.",
    reply:
      "There is no config.toml in the working folder — and nothing else here shares that name. If the config lives somewhere specific, point me at the path.",
  },
  {
    ask: "where do we handle websocket reconnects?",
    call: ["search_code", { query: "websocket reconnect" }],
    error: 'No matches for "websocket reconnect" in the workspace.',
    reply:
      "Nothing in the working folders mentions websocket reconnects — either it is not implemented here, or it lives in a folder that is not attached.",
  },
  {
    ask: "remove the deprecated flag from cli.py",
    call: [
      "edit_file",
      { path: "cli.py", old_string: "parser.add_argument('--legacy')", new_string: "" },
    ],
    error:
      "old_string was not found in cli.py. Read the file and copy the passage exactly, without line numbers.",
    recover: [
      {
        call: ["read_file", { path: "cli.py" }],
        output: numbered(`import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--verbose")
parser.add_argument("--legacy", help="deprecated")
print(parser.parse_args())`),
      },
      {
        call: [
          "edit_file",
          {
            path: "cli.py",
            old_string: 'parser.add_argument("--legacy", help="deprecated")\n',
            new_string: "",
          },
        ],
        output: "Edited cli.py.",
      },
    ],
    reply:
      "Removed the deprecated --legacy flag from cli.py. My first edit guessed at the exact text and missed, so I read the file and copied the real line before retrying.",
  },
]);

/* ------------------------------------------------------------------ */

/** Every training conversation, as message arrays. */
export function scenarios() {
  const all = [...CREATE, ...DOCUMENT, ...EDIT, ...DEBUG, ...SEARCH, ...DIRECT, ...ERRORS];
  return all.map((build) => build());
}

/**
 * Held-out eval tasks — none of these prompts appear above. `expect` is the
 * tool a correct first move calls, or null when the right move is answering
 * directly. Off-domain entries guard against the adapter inventing tool
 * calls for turns that need none.
 */
export function goldenTasks() {
  return [
    { prompt: "write a python script that prints the ten largest files in a folder", expect: "write_file" },
    { prompt: "make me a shell script that deletes .DS_Store files recursively", expect: "write_file" },
    { prompt: "write me a short thank you letter to my landlord as a document", expect: "write_file" },
    { prompt: "draft a project status report I can send my manager", expect: "write_file" },
    { prompt: "change the timeout in worker.js from 30 to 60 seconds", expect: "read_file" },
    { prompt: "fix the typo in the heading of index.html", expect: "read_file" },
    // Adding to an existing file starts by reading it — write_file here is
    // the rewrite-and-lose-everything failure observed live.
    { prompt: "add a dark mode toggle to my settings page in settings.js", expect: "read_file" },
    { prompt: "run the test suite", expect: "run_command" },
    { prompt: "is the git working tree clean?", expect: "run_command" },
    { prompt: "where is the email validation implemented?", expect: "search_code" },
    { prompt: "which file configures logging?", expect: "search_code" },
    { prompt: "what is in requirements.txt?", expect: "read_file" },
    { prompt: "show me the readme", expect: "read_file" },
    // Off-domain: correct behavior is a direct answer, no tool call.
    { prompt: "what does the acronym API stand for?", expect: null },
    { prompt: "explain the difference between a list and a tuple in python", expect: null },
    { prompt: "is tabs or spaces more common in python code?", expect: null },
    // Recovery probes: the turn is mid-flight, a tool just failed, and what
    // is scored is the next move. None of these situations appear above.
    goldenRecovery({
      prompt: "how many commits are on this branch?",
      call: ["run_command", { command: "git rev-list --count HEAD" }],
      error: "fatal: not a git repository (or any of the parent directories): .git",
      expect: null,
    }),
    goldenRecovery({
      prompt: "run the linter",
      call: ["run_command", { command: "npx eslint ." }],
      error: "zsh: command not found: npx",
      expect: null,
    }),
    goldenRecovery({
      prompt: "what dependencies does the project declare?",
      call: ["read_file", { path: "package.json" }],
      error: 'Error: no file at package.json. Did you mean "app/package.json"?',
      expect: "read_file",
    }),
    // Abstention probes: the look has happened and found nothing. The
    // coder's honest shape is "it is not here", not a second guess at a
    // path, and not an answer about a file it never read. None of these
    // names appear anywhere above.
    goldenAbstain({
      prompt: "what does the function frobnicateLedger in utils/legacy.py do?",
      call: ["search_code", { query: "frobnicateLedger" }],
      output: "No matches for \"frobnicateLedger\" in the workspace.",
    }),
    goldenAbstain({
      prompt: "summarise the deployment notes in ops/runbook-q3.md",
      call: ["read_file", { path: "ops/runbook-q3.md" }],
      output: "Error: no file at ops/runbook-q3.md",
    }),
    goldenAbstain({
      prompt: "what did Priya decide about the Halvorsen retry budget?",
      call: ["search_code", { query: "Halvorsen" }],
      output: "No matches for \"Halvorsen\" in the workspace.",
    }),
    goldenAbstain({
      prompt: "which value does MAX_TENANTS have in the config?",
      call: ["search_code", { query: "MAX_TENANTS" }],
      output: "No matches for \"MAX_TENANTS\" in the workspace.",
    }),
  ];
}
