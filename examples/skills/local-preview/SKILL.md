---
name: local-preview
description: Serving a page or site locally to test it — starting a local web server, checking it responds, and giving the user a URL to open. Use when a web page, site or front end has been written and needs to be run, previewed, tested in a browser, or checked that it actually works.
allowed-tools: [run_command, read_file]
---

# Running a page locally

## This is a testing task, not a writing one

The file already exists. Do not rewrite it, and do not "improve" it on the
way past — serve what is there and report what happened. If it turns out to
be broken, say what broke; changing it is a separate request.

## Serve the folder, then check it

A static page needs a server for anything beyond plain HTML — scripts loaded
as modules, `fetch`, and stored data all fail on a `file://` path even though
the file is fine.

```
run_command  command: "python3 -m http.server 8123 --bind 127.0.0.1 --directory ."  background: true
```

`background: true` is required. Without it the call waits for the server to
exit, which it never does, and it is killed after a minute.

`--bind 127.0.0.1` is required too — without it the folder is served to
everyone on the network, and the command is refused.

Then check it responded, in the *next* call:

```
run_command  command: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8123/index.html"
```

`200` means it is serving. `000` means nothing is listening — read the output
from the start command, which says why.

## Then say where it is

End with the URL on its own line, so the user can open it:

`http://127.0.0.1:8123/index.html`

You cannot see the page. Do not describe how it looks, whether it is
"clean" or "responsive", or what happens when a button is clicked — you have
not clicked it. Report what you checked: the status code, and anything you
verified with curl.

## Checking content without a browser

`curl -s <url>` prints the page. Use it to confirm what actually reached the
browser — that the script tag is there, that a template was filled in, that
the file being served is the one you just wrote.

For a page that builds itself with JavaScript, curl shows the empty shell and
nothing more. That is expected and is not a bug; say the markup is served and
that the behaviour needs a person to look.

## Ports

Use 8123 unless it is taken. If the start command says `Address already in
use`, try 8124, then 8125. Do not try to kill whatever holds the port.

## When there is a project of its own

A folder with a `package.json` that has a `dev` or `start` script is run with
that, not with `http.server`:

```
run_command  command: "npm run dev"  background: true
```

Read its output for the URL it prints — frameworks choose their own port —
and use that instead of guessing one.
