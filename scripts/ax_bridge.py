#!/usr/bin/env python3
"""
The accessibility tree, read and pressed directly.

enio reaches the tree through AppleScript's System Events, which is the
obvious door and not the only one. Some apps are invisible through it:
Calculator reports zero windows to System Events while sitting on screen, so
no click could ever reach it, and the error it returns (-1719) is the same
code System Events uses for a missing permission -- a wall that also
misdiagnoses itself.

The same tree through the AXUIElement API answers immediately: one window,
every button named, and a press that works. So the ceiling was never the
accessibility tree, it was the intermediary.

Kept as a separate process rather than a native module on purpose. A native
addon has to be built per Node version and per architecture, and this is a
capability that must degrade rather than fail -- if pyobjc is missing or
macOS refuses, the caller falls back to AppleScript and everything that
worked before still works.

Output is JSON on stdout, always: the caller should never have to parse prose
to find out whether something happened.

Usage:
    ax_bridge.py tree  <app> [--depth N] [--max N]
    ax_bridge.py press <app> <element name>
"""

import json
import sys

try:
    import ApplicationServices as AS
    from AppKit import NSWorkspace
except ImportError:  # pragma: no cover - the caller checks availability first
    print(json.dumps({"ok": False, "error": "pyobjc is not installed"}))
    sys.exit(1)


def fail(message):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def pid_for(app_name):
    """The pid of a running app, matched the way people name apps.

    Exact first, then case-insensitive, then unique prefix -- the same
    resolution order the TypeScript side uses, so "calculator" means the same
    thing on both sides of the bridge.
    """
    running = [
        a for a in NSWorkspace.sharedWorkspace().runningApplications()
        if a.localizedName()
    ]
    for match in (
        lambda a: a.localizedName() == app_name,
        lambda a: a.localizedName().lower() == app_name.lower(),
        lambda a: a.localizedName().lower().startswith(app_name.lower()),
    ):
        hits = [a for a in running if match(a)]
        if len(hits) == 1:
            return hits[0].processIdentifier(), hits[0].localizedName()
    return None, None


def attr(element, key):
    err, value = AS.AXUIElementCopyAttributeValue(element, key, None)
    return value if err == 0 else None


def label_of(element):
    """What a person would call this element.

    Title, then description, then value -- a button carries its label in
    whichever of those the app bothered to set, and an element with none of
    them is not something anyone can ask for by name.
    """
    for key in (AS.kAXTitleAttribute, AS.kAXDescriptionAttribute, AS.kAXValueAttribute):
        value = attr(element, key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def walk(root, depth_limit, budget):
    """Breadth-first, bounded, the same shape as the AppleScript walk.

    Bounded for the reason recorded there: a browser's tree is effectively
    unbounded, and a list past a few hundred rows has stopped being something
    to choose from.
    """
    rows, seen, frontier = [], 0, [root]
    for _ in range(depth_limit):
        nxt = []
        for parent in frontier:
            seen += 1
            if seen > budget:
                return rows, True
            for kid in attr(parent, AS.kAXChildrenAttribute) or []:
                label = label_of(kid)
                if label:
                    role = attr(kid, AS.kAXRoleDescriptionAttribute) or attr(kid, AS.kAXRoleAttribute) or "element"
                    rows.append(f"{role}: {label}")
                nxt.append(kid)
        if not nxt:
            break
        frontier = nxt
    return rows, False


def find(root, wanted, depth_limit, budget):
    seen, frontier = 0, [root]
    for _ in range(depth_limit):
        nxt = []
        for parent in frontier:
            seen += 1
            if seen > budget:
                return None
            for kid in attr(parent, AS.kAXChildrenAttribute) or []:
                if label_of(kid) == wanted:
                    return kid
                nxt.append(kid)
        if not nxt:
            return None
        frontier = nxt
    return None


def main(argv):
    if len(argv) < 3:
        fail("usage: ax_bridge.py tree|press <app> [name]")

    command, app_name = argv[1], argv[2]
    depth = 8
    budget = 400
    if "--depth" in argv:
        depth = int(argv[argv.index("--depth") + 1])

    pid, resolved = pid_for(app_name)
    if pid is None:
        fail(f"{app_name} is not running")

    app = AS.AXUIElementCreateApplication(pid)
    windows = attr(app, AS.kAXWindowsAttribute) or []
    if not windows:
        fail(f"{resolved} has no window open")

    if command == "tree":
        rows, truncated = walk(windows[0], depth, budget)
        print(json.dumps({"ok": True, "app": resolved, "rows": rows, "truncated": truncated}))
        return 0

    if command == "press":
        if len(argv) < 4:
            fail("press needs an element name")
        wanted = argv[3]
        element = find(windows[0], wanted, depth, budget)
        if element is None:
            fail(f'no control named "{wanted}" in the front window of {resolved}')
        err = AS.AXUIElementPerformAction(element, AS.kAXPressAction)
        if err != 0:
            fail(f'"{wanted}" would not accept a press (AX error {err})')
        print(json.dumps({"ok": True, "app": resolved, "pressed": wanted}))
        return 0

    fail(f"unknown command {command}")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
