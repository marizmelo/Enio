---
name: computer-control
description: Controlling this Mac through AppleScript — reading Mail, Calendar, Notes, Reminders, and Finder. Use for "show my emails", "what's on my calendar", "read my notes", "what's due", or similar requests about the user's own apps.
allowed-tools: [run_applescript]
---

# Controlling the Mac

You cannot write AppleScript reliably from scratch, and a script with one
wrong word errors out. So do not compose your own — copy a recipe below,
change only the number of items or the search text, and pass it to
`run_applescript` exactly. Every one of these is tested and works.

Read one thing at a time. Get the result back, then answer from it — do not
chain several scripts before reading any output.

## Mail

Most recent messages, subject and sender (change `1 thru 5` for a different count):

```applescript
tell application "Mail" to get {subject, sender} of messages 1 thru 5 of inbox
```

Unread count:

```applescript
tell application "Mail" to get unread count of inbox
```

Full text of the most recent message:

```applescript
tell application "Mail" to get content of message 1 of inbox
```

The result comes back as a flat comma-separated list — all the subjects, then
all the senders. Pair them up by position when you report them.

## Calendar

Today's events (title and start time) from the default calendar:

```applescript
tell application "Calendar"
	set today to current date
	set today's hours to 0
	set today's minutes to 0
	set today's seconds to 0
	set tomorrow to today + 1 * days
	set out to {}
	repeat with e in (every event of calendar 1 whose start date ≥ today and start date < tomorrow)
		set end of out to (summary of e) & " at " & (start date of e as string)
	end repeat
	return out
end tell
```

## Reminders

Everything not yet done:

```applescript
tell application "Reminders" to get name of (reminders whose completed is false)
```

## Notes

Titles of the most recent notes:

```applescript
tell application "Notes" to get name of notes 1 thru 5
```

Body of a note by title (change the name):

```applescript
tell application "Notes" to get body of note "Shopping list"
```

## Finder

Files on the Desktop:

```applescript
tell application "Finder" to get name of items of desktop
```

## When a script errors

If `run_applescript` returns an error, do not guess at a fix and do not invent
a different tool — `run_applescript` is the only tool you have here. Read the
error, and if it names a missing permission, tell the user which app needs
Automation access in System Settings › Privacy & Security. Otherwise say plainly
that you could not read it, rather than trying variations.
