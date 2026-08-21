---
title: Accounts
layout: default
nav_order: 15
---

# Accounts

An account lets Enio reach something of yours that lives online — your Gmail,
your Calendar, your Drive — rather than only what is on this machine.

It is set up in **Connections** (the **+** in the composer → Connection →
Manage connections). Google is the first provider.

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

## Setting it up

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

**Remove** in Connections deletes the tokens from this machine, so Enio stops
using the account immediately.

It does not revoke the grant at Google — only Google can do that, at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions),
and the panel links there next to the button. Do both if you are removing an
account because something went wrong.

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
