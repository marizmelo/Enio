---
title: Accounts
layout: default
nav_order: 15
---

# Accounts

An account lets Enio reach something of yours that lives online — your Gmail,
your Calendar, your Drive — rather than only what is on this machine.

Your own accounts are set up in **Connections** (the plug in the toolbar).
Enio's own account — the address it sends from, the calendar it can be
invited to — is set up in **Settings** (the gear). Which door you connect
through is what says whose it is. Google is the first provider.

## No passwords, ever

Enio will not store an account password, and this is a decision rather than a
gap. A password is *unscoped*: it grants everything the account can do,
including changing the recovery address and every other credential. It cannot
be narrowed to "read my calendar". And with two-factor turned on it barely
works alone anyway — a stored password gets as far as a code prompt. That is
the maximum risk for a partial capability.

OAuth is the alternative and it is better on every axis that matters: each
grant is *scoped*, it is *revocable* from Google's own settings without
touching your password, and Enio never sees the password at all.

## What you allow, and nothing more

Access is picked from a short list rather than typed as scopes:

| | Reads | Changes |
|---|---|---|
| Mail | subjects, senders, message bodies | sends new messages |
| Calendar | events and times | creates and edits events |
| Drive | files you point it at | creates and edits files |

**Read grants are ticked by default; the ones that change things are not.**
Turning one on is a separate, deliberate act — shown in amber, because more
access is more that can go wrong if a page ever talks the model into
something. Grant what you actually want it doing.

Sending is granted as *send only*, never Gmail's broader "modify" permission,
so Enio can write you a draft and send it but cannot delete your mail.

## Connecting with a script

The shorter road, and the one that needs nothing from Google Cloud. You paste
a script Enio gives you into your own Google account and deploy it; the script
runs as you, so there is no application to register and nothing to verify.

Enio cannot deploy it for you. Doing that would need the Apps Script API,
which needs a Cloud project and OAuth credentials — the very things this
avoids. So it hands you the code and walks the deploy:

1. Copy the code from Connections, open [script.new](https://script.new) and paste it, replacing what is there
2. **Deploy → New deployment → Web app**
3. Execute as **Me**, Who has access **Anyone**
4. Authorize it — you will see a warning screen; see below
5. Copy the `/exec` URL and paste it back into Enio

To check a deployment yourself, open its URL in a private browser window: a
working one says **"Enio bridge is running"**. If Enio reports that Google
refused the call even though access says *Anyone*, make a **New deployment**
and paste its fresh URL — access edited on an existing deployment sometimes
never takes effect, which was observed rather than read about.

### The "Google hasn't verified this app" screen

You will see this at step 4, and it is expected. It means nobody has paid
Google to review the app — and nobody would, because **the app is you**: a
script you just wrote, in your own account, running as yourself. Choose
**Advanced**, then the "Go to … (unsafe)" link, then **Allow**.

**The check worth making every time:** the screen names the developer. If
that address is *yours*, it is your script and continuing is right. If it
ever names someone else, stop — that is a different app asking for your
mailbox.

### What the script can do, and what it cannot

The script is a fixed list of operations: read and send mail, list and add
calendar events (with a **Meet** link on request), find and read Drive files,
create and append to **Docs**, create **Slides**, append rows to **Sheets**,
list and add **Tasks** (todos), create **Forms** and read their responses,
look up **Contacts**, and **translate** text. **Nothing in it deletes anything** — there is no function that
could, which is checked by a test in Enio itself. Sheets access is
append-only for the same reason: an added row is visible and reversible by
hand, where an overwritten cell silently destroys what was there.

The honest gaps, so nobody hunts for them: **Google Keep** and **Google
Vids** have no API a consumer account can reach; the **Photos** API stopped
serving anything an app did not itself upload (2025); and **Chat** needs its
own Cloud-project app configuration — the exact dependency this path exists
to avoid. Enio's own [Notes](notes.md) covers the Keep-shaped need locally.

Three operations lean on "advanced services", each one click in the editor
(**+** next to *Services* → Add → deploy a new version), and each fails with
that exact instruction rather than a bare error until enabled: **Tasks** for
todos, **Peopleapi** for contacts, **Calendar API** for Meet links.

**Upgrading the script** when Enio adds operations: copy the code again from
Connections — it carries your connected account's key — replace the file,
then *Deploy → Manage deployments → edit → Version: New version → Deploy*.
The URL stays the same and nothing needs reconnecting.

That matters because of how it is reached. The deployment URL is a **bearer
credential**: whoever holds it can call what the script exposes. Enio also
sends a secret with every call, so a leaked URL alone is not enough, but
treat the URL like a password. Revoke it in Apps Script under **Deploy →
Manage deployments**, or by deleting the project.

The trade against OAuth, plainly: a script is faster to set up and depends on
nobody, but its access is all-or-nothing and revoking means removing the
deployment. OAuth grants are individually scoped and revocable at Google, at
the cost of registering an application first.

## Setting it up with OAuth instead

Google ties mail and calendar access to a registered application, so Enio
needs one to identify itself as. It uses one **you** own:

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com/projectcreate)
2. In **APIs & Services → Library**, enable the Gmail, Calendar and Drive APIs
3. In **OAuth consent screen**, choose External and add yourself under **Test users**
4. In **Credentials**, create an OAuth client ID of type **Desktop app**
5. Back on **OAuth consent screen**, press **Publish app**

Paste the client ID and secret into Connections. About five minutes, once.

Step 5 is the one worth not skipping, because leaving it out fails a week
later rather than straight away. Google issues an external consent screen
left in *Testing* a sign-in that **expires after seven days**, so the account
would quietly stop working and you would reconnect every week. Publishing
keeps it. You will see an "unverified app" notice when you sign in — it is
your own app, so choose Advanced and continue.

That step exists because of how Google treats these permissions, not because
Enio wants your details: Gmail's read permission is a *restricted* scope, and
an application published for everyone to use needs Google's review plus a
security assessment renewed every year. With your own client none of that
applies to you: it is your project, your quota and your consent screen, used
by one person, and there is no shared secret anywhere.

Sign-in happens in your normal browser, never in a window Enio draws. That is
not a preference: Google refuses OAuth inside embedded browsers outright,
because an app that draws its own login window could read what you type into
it.

## Removing an account

**Remove** in Connections or Settings deletes the tokens from this machine, so Enio stops
using the account immediately.

It does not revoke the grant at Google — only Google can do that, at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions),
and the panel links there next to the button. Do both if you are removing an
account because something went wrong.

## Whose account is it

Asking in chat works too: "let's set up a new email account", "connect my
gmail" or "open accounts" opens Connections directly, and "open settings"
opens Settings — a harness act, not a tool the agent holds, so it is one
sentence and the panel.

Two kinds of account can be connected, and they must never be confused:

- **Enio's own account** is the agent's identity: the address it sends
  from, the calendar it can be invited to, the Drive it can write to. Create
  a Google account for it and connect it under **Settings**, first.
- **Your accounts** are access to *your* mail, calendar and files, in your
  name, connected under **Connections**. "My inbox" always means one of
  these.

With only Enio's own account connected, "my inbox" reads nothing — Enio's
mail is never presented as yours — but calendar, todo and contact questions
use Enio's account and say so, since a calendar grant on it is something
you set up; a notice under the reply carries the link to connect yours.

Which door you connect through is what records whose it is, so nothing
asks; each account also takes a label ("work", "personal"). An account
connected before the two doors existed shows under Connections with the
question "whose account is this?", and either list lets you move an
account to the other side. Replies and notices name the account the way
you did: "Searched your account work (…)" or "Sent from Enio's own
account". From the terminal, `enio accounts` lists them and
`enio accounts owner <id> agent|user [label]` sets it.

Which account a conversation uses is yours to pick: the account chip in the
top bar, or a phrase — "use my work email", "switch to Enio's account" —
which is matched against the connected list and confirmed with a notice.
A conversation keeps its choice. With no choice, the default account from
the panel applies; with no default, reading uses your account and sending
uses Enio's own. The agent can name an account in a tool call when you
named one, and the choice is only kept when your message backs it: it holds
the account's label or address, or, for Enio's own account, it speaks of
Enio ("your inbox", "did anyone write to you"). An account the agent
picked with nothing of yours behind it is ignored, and the conversation's
account is read.

**"My" and "your" work too, for one question at a time.** Talking to Enio,
*your* inbox is Enio's and *my* inbox is yours. "Check your email",
"anything in your inbox?" and "did anyone write to you?" look in Enio's own
account; "check my email" and "what's on my calendar" look in yours, even
when the conversation is set to Enio's. It applies to that one message:
the next one that names no one goes back to the conversation's account.
Opening a message from a list you just saw opens it in the mailbox it was
listed from.

To move the whole conversation, use the account chip or the account's
name, as above. "My" and "your" never move it.

**In an automation, the step says whose.** None of the above reaches a
step of an automation: it has no conversation and nobody's words. A step
that reads or sends mail, or uses the calendar, has its own Account choice
instead — see [Automations](pipelines.md). A step set to an account uses
that account or fails with the reason; it never falls back to another.

Four things worth knowing:

- It steers reading **mail and the calendar**, and nothing else. Where a
  message is sent from, whose calendar an event is added to, and which
  Drive is searched follow the conversation's account — sending and adding
  are the things that cannot be taken back.
- Only a request to look in a mailbox or calendar counts. "What's your
  email address?", "send it to my email" and "did you get my email?"
  change nothing. Text in quotation marks, after a colon, on a second line,
  or reported ("Google says check your email") is treated as somebody
  else's words; a short paste with none of those marks can still be taken
  for a request.
- It reads the plain ways of saying it and misses roundabout ones, and a
  message that names both ("check mine, then yours") chooses neither. When
  it misses, the agent's own reading of your message decides, as it did
  before, within the limit above. Mail and calendar replies say whose
  account was read.
- If the agent answers a "my" or "your" request without looking in that
  mailbox (it sometimes answers from mail already in the conversation),
  Enio searches it and answers again. You will see a note saying so.

## Email through the account

Once an account with the mail grants is connected, the **Email** tile on the
landing page comes alive and the mail tools flow through it — no IMAP or
SMTP setup needed. The three routes, in the order worth trying:

1. **A connected Google account** — this page; the script route needs no
   Google Cloud setup at all
2. **The Mail app on this computer** — enable desktop control and Enio reads
   what Mail shows, through the app itself
3. **Any provider by hand** — `ENIO_IMAP_*` to read, `ENIO_SMTP_*` to send

A connected account outranks IMAP when both exist, and two lines hold
whatever the backend: **Enio never sends a message itself**, and an account
connected without the send grant is not a send path — the grant is checked
where the send happens, not in a prompt.

**Writing and sending.** Ask Enio to send, reply or draft, and it writes the
message and stops. The reply shows the whole message and says it has not been
sent; under it is a card with **Send**, **Edit** and **Discard**. Nothing
leaves until you press Send, and what goes is the message as it stands on the
card — if you edited it, your edit.

- Ask for changes in words ("make it shorter", "add that I will bring the
  wine") and Enio writes it again; the new version takes the place of the one
  it revises, and the older card says so.
- "Send it" typed into the chat does not send. Enio answers that the message
  is waiting for you, because sending is the one step it cannot take.
- What you did is written into the conversation: "You sent the message to …"
  or "You discarded the message to …".
- A message you have not decided on survives a restart; its card comes back
  when you reopen the conversation.

**Send works once `ENIO_EMAIL_SEND=1` is set.** Until then the message is
written, shown, kept as a draft (and saved as a `.eml` file among your
[assets](assets.md)), and the Send button says sending is switched off.
`ENIO_EMAIL_ALLOWED_TO` limits who a message may go to; it is checked on every
address in To and Cc, when the message is written and again when it is sent.

From a terminal there is no card, so the same three things are commands:

```sh
enio outbox              # what is waiting
enio outbox show ID      # the whole message
enio outbox send ID      # send it
enio outbox drop ID      # discard it
```

Inside `enio chat`, `/send` and `/drop` act on the message written in that
conversation.

**In an automation.** A step that writes a message does not send it either.
When you ran the [automation](pipelines.md) from a conversation, the message
is left in that conversation: its card appears under the run's outcome, and
comes back when you reopen the conversation. When the automation ran on a
schedule or from the Automations panel there is no conversation to put a card
in, so the message waits in the outbox and the step's reply says so:
`enio outbox` lists it and `enio outbox send ID` sends it.

**A Cc on a connected Google account is not delivered.** The script route
sends to the To line only. When a message has a Cc, Enio says so before you
send — in the reply and on the card — and adds a line naming those addresses
at the end of the message. To reach them, move them to To. Mail sent through
`ENIO_SMTP_*` carries a Cc normally.

## Calendar, todos and contacts

With an account connected, a **planner** agent appears alongside the others:
ask "what's on my calendar this week", "add lunch with Ana on Friday, with a
Meet link", "add finish the deck to my todos", or "what's Ana's email". The
Calendar tile on the landing page is the same thing, picked by hand.

Reading works with any connected account. Adding events and todos needs the
**Add and change events** grant — an account connected read-only is not a
write path, and the agent will say so rather than trying anyway. Todos need
the Tasks service enabled once in the script editor; the error tells you
exactly where when it is missing.

Drive is readable from chat too: "find my Q3 deck and tell me what it
claims" searches by name and reads Docs, Slides and Sheets as text (script
v5 — upgrade if yours is older). Creating documents from chat is the one
piece still unwired; automations can compose the read half with mail today,
which covers check-then-send.

## What the agent can and cannot do with it

The agent never holds a credential. It asks for an action — read this thread,
add that event — and Enio attaches the token on the way out. No tool can list
your accounts, read a token, or start a sign-in.

That is the same rule that governs [background
processes](projects.md) (an agent may start one, only you can see or stop
them) and cloud handoffs (an agent may package one, only you can send it).
It means an escalation cannot be something the model talks itself into, and
a web page it reads cannot talk it into one either.

Tokens live in `~/.enio/accounts.json`, readable only by your user account.
