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

Several techniques here are mined from Peekaboo (openclaw/Peekaboo, MIT),
which drives the same API from Swift: batched attribute reads, messaging
timeouts instead of hangs, press-action verification, focused-window
resolution, identifier/descendant label fallbacks, and typing by setting
kAXValueAttribute rather than synthesizing keystrokes. What was deliberately
not taken: its opaque element IDs (names are enio's protocol), and its
private-API event posting (SLEventPostToPid) -- see DECISIONS.md.

Output is JSON on stdout, always: the caller should never have to parse prose
to find out whether something happened.

Usage:
    ax_bridge.py tree    <app> [--depth N]
    ax_bridge.py press   <app> <element name>
    ax_bridge.py settext <app> <text> [--field <element name>]
"""

import json
import re
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


# kAXIdentifierAttribute exists in the headers but not every pyobjc build
# exports the constant; the literal is the attribute's actual name.
IDENTIFIER_ATTR = getattr(AS, "kAXIdentifierAttribute", "AXIdentifier")

# Everything a tree row or a press decision needs, fetched in ONE IPC
# round-trip per element via AXUIElementCopyMultipleAttributeValues. The
# per-attribute loop this replaces paid a round-trip per key -- a label alone
# cost up to three -- and IPC, not computation, is where a tree walk's time
# goes. (Technique from Peekaboo's AXDescriptorReader.)
BATCH_KEYS = [
    AS.kAXTitleAttribute,
    AS.kAXDescriptionAttribute,
    AS.kAXValueAttribute,
    AS.kAXRoleDescriptionAttribute,
    AS.kAXRoleAttribute,
    AS.kAXSubroleAttribute,
    AS.kAXEnabledAttribute,
    IDENTIFIER_ATTR,
    AS.kAXChildrenAttribute,
]


def _text(v):
    """A usable string, or None. Batch reads hand back AXValue error
    placeholders for absent attributes; the type check is what filters them."""
    return v.strip() if isinstance(v, str) and v.strip() else None


def read(element):
    """One element's attributes as a dict, one round-trip when possible."""
    err, values = AS.AXUIElementCopyMultipleAttributeValues(element, BATCH_KEYS, 0, None)
    if err != 0 or values is None or len(values) != len(BATCH_KEYS):
        values = [attr(element, k) for k in BATCH_KEYS]
    title, desc, value, role_desc, role, subrole, enabled, ident, children = values
    if children is None or isinstance(children, (str, bool, int, float)) or not hasattr(children, "__len__"):
        children = []
    return {
        "title": _text(title),
        "desc": _text(desc),
        "value": _text(value),
        "role_desc": _text(role_desc),
        "role": _text(role),
        "subrole": _text(subrole),
        # Unknown reads as enabled: over-filtering hides real controls, and a
        # press on a genuinely disabled one still fails honestly.
        "enabled": enabled not in (False, 0),
        "ident": _text(ident),
        "children": children,
    }


def cleaned_identifier(ident):
    """A developer identifier as a human label: "save-button" -> "save button".

    Skipped when it reads as generated noise -- a UUID row is not a name
    anyone can ask for.
    """
    if not ident or re.fullmatch(r"[0-9a-fA-F:-]{8,}", ident):
        return None
    return _text(re.sub(r"[-_.:]+", " ", ident))


# Roles worth paying extra round-trips to name when they carry no label of
# their own -- an unlabeled toolbar button usually holds its caption in a
# static-text child. Containers are excluded: naming a group after its first
# text would put misleading rows in the list.
DESCENDANT_LABEL_ROLES = {"AXButton", "AXLink", "AXMenuButton", "AXPopUpButton"}


def descendant_label(element):
    """A label assembled from textual children, bounded hard."""
    texts, frontier, visited = [], [element], 0
    for _ in range(3):
        nxt = []
        for parent in frontier:
            visited += 1
            if visited > 30 or len(texts) >= 4:
                break
            for kid in attr(parent, AS.kAXChildrenAttribute) or []:
                node = read(kid)
                if node["role"] == "AXStaticText":
                    label = node["value"] or node["title"]
                    if label:
                        texts.append(label)
                nxt.append(kid)
        if not nxt or len(texts) >= 4:
            break
        frontier = nxt
    return _text(" ".join(texts)) or None


def label_of(node, element=None):
    """What a person would call this element.

    Title, then description, then value; then the cleaned developer
    identifier; then, for button-ish roles only, text found in descendants.
    An element with none of these is not something anyone can ask for by
    name.
    """
    label = node["title"] or node["desc"] or node["value"] or cleaned_identifier(node["ident"])
    if not label and element is not None and node["role"] in DESCENDANT_LABEL_ROLES:
        label = descendant_label(element)
    return label[:80] if label else None


# Roles that advertise AXPress on some apps but are never what a person means
# by a name -- pressing the scroll area that *contains* Save is not clicking
# Save. (Set from Peekaboo's nonPressableContainerRoles.)
CONTAINER_ROLES = {
    "AXGroup", "AXScrollArea", "AXWebArea", "AXWindow",
    "AXLayoutArea", "AXRadioGroup", "AXApplication",
}


def supports_press(element):
    err, actions = AS.AXUIElementCopyActionNames(element, None)
    if err != 0 or actions is None:
        # Unknown is not "no": some apps refuse the action-names read while
        # accepting the press itself.
        return True
    return AS.kAXPressAction in list(actions)


def front_window(app):
    """The window the user would say they are looking at.

    windows[0] -- the old behaviour -- is not reliably the front window; the
    focused window is, with the main window and then the raw list as the
    degrade path.
    """
    for key in (AS.kAXFocusedWindowAttribute, AS.kAXMainWindowAttribute):
        win = attr(app, key)
        if win is not None:
            return win
    windows = attr(app, AS.kAXWindowsAttribute) or []
    return windows[0] if windows else None


def walk(root, depth_limit, budget):
    """Breadth-first, bounded, the same shape as the AppleScript walk.

    Bounded for the reason recorded there: a browser's tree is effectively
    unbounded, and a list past a few hundred rows has stopped being something
    to choose from. Disabled controls are left out -- a row the press would
    refuse is noise in a list that exists to be chosen from.

    The menu bar is never descended into. Some apps (Calculator) hang it off
    the same element the walk starts from, and its rows are the wrong list
    twice over: menus belong to the menu_items recipe, and the Apple menu it
    starts with is where Shut Down and Log Out live -- names that must not
    appear in a closed list meant for choosing window controls from.
    """
    rows, seen, frontier = [], 0, [root]
    for _ in range(depth_limit):
        nxt = []
        for parent in frontier:
            seen += 1
            if seen > budget:
                return rows, True
            for kid in attr(parent, AS.kAXChildrenAttribute) or []:
                node = read(kid)
                if node["role"] == "AXMenuBar":
                    continue
                label = label_of(node, kid)
                if label and node["enabled"]:
                    role = node["role_desc"] or node["role"] or "element"
                    rows.append(f"{role}: {label}")
                nxt.append(kid)
        if not nxt:
            break
        frontier = nxt
    return rows, False


def find(root, wanted, depth_limit, budget, pressable=False):
    """The element called `wanted`, or (None, reason).

    With pressable=True, a matching element must be enabled, must not be a
    container role, and should support AXPress -- and when only an
    unpressable match exists, the reason says what was actually found, so
    "found but disabled" never reads as "not there".
    """
    seen, frontier, rejected = 0, [root], None
    for _ in range(depth_limit):
        nxt = []
        for parent in frontier:
            seen += 1
            if seen > budget:
                return None, rejected
            for kid in attr(parent, AS.kAXChildrenAttribute) or []:
                node = read(kid)
                # Same exclusion as the walk: what cannot be listed must not
                # be pressable, or the two limits drift apart.
                if node["role"] == "AXMenuBar":
                    continue
                if label_of(node, kid) == wanted:
                    if not pressable:
                        return kid, None
                    if not node["enabled"]:
                        rejected = f'"{wanted}" is there but disabled right now'
                    elif node["role"] in CONTAINER_ROLES:
                        rejected = f'"{wanted}" is a {node["role_desc"] or "container"}, not a control'
                    elif not supports_press(kid):
                        rejected = f'"{wanted}" does not accept a press'
                    else:
                        return kid, None
                nxt.append(kid)
        if not nxt:
            break
        frontier = nxt
    return None, rejected


def do_settext(app, resolved, text, field, depth, budget):
    """Type by setting the field's value -- no focus steal, no keystrokes.

    The AppleScript path types by bringing the app forward and synthesizing
    keystrokes into whatever ends up focused, which its own comment calls the
    worst possible failure for typing. Setting kAXValueAttribute writes into
    the *named* element of the *named* app, frontmost or not.

    Two structural guarantees the keystroke path cannot offer: a secure text
    field is refused by role, so this command cannot type into a password
    field even if asked; and a field that is not settable errors by name
    instead of typing into the void.
    """
    if field:
        window = front_window(app)
        if window is None:
            fail(f"{resolved} has no window open")
        element, why = find(window, field, depth, budget)
        if element is None:
            fail(why or f'no field named "{field}" in the front window of {resolved}')
        target_name = field
    else:
        element = attr(app, AS.kAXFocusedUIElementAttribute)
        if element is None:
            fail(f"{resolved} has no focused field to type into — name one with --field")
        target_name = "the focused field"

    node = read(element)
    if node["role"] == "AXSecureTextField" or node["subrole"] == "AXSecureTextField":
        fail("that is a password field — this will not type into it")

    err, settable = AS.AXUIElementIsAttributeSettable(element, AS.kAXValueAttribute, None)
    if err != 0 or not settable:
        fail(f'{target_name} in {resolved} does not accept text this way')

    err = AS.AXUIElementSetAttributeValue(element, AS.kAXValueAttribute, text)
    if err != 0:
        fail(f"could not set the text (AX error {err})")

    # Cursor to the end, as typing would have left it. Cosmetic: a failure
    # here changes nothing about the text that was set.
    try:
        from CoreFoundation import CFRangeMake
        rng = AS.AXValueCreate(AS.kAXValueCFRangeType, CFRangeMake(len(text), 0))
        if rng is not None:
            AS.AXUIElementSetAttributeValue(element, AS.kAXSelectedTextRangeAttribute, rng)
    except Exception:
        pass

    print(json.dumps({"ok": True, "app": resolved, "typed_into": target_name}))


def main(argv):
    if len(argv) < 3:
        fail("usage: ax_bridge.py tree|press|settext <app> [value] [--field name]")

    command, app_name = argv[1], argv[2]
    depth = 8
    budget = 400
    if "--depth" in argv:
        depth = int(argv[argv.index("--depth") + 1])
    field = None
    if "--field" in argv:
        field = argv[argv.index("--field") + 1]

    pid, resolved = pid_for(app_name)
    if pid is None:
        fail(f"{app_name} is not running")

    # A wedged app must answer "cannot complete", not hang this process until
    # the caller's 30s timeout kills it with nothing on stdout. Set on the
    # system-wide element, which makes it the default for every element this
    # process talks to. (Technique from Peekaboo; API: AXUIElementSetMessagingTimeout.)
    AS.AXUIElementSetMessagingTimeout(AS.AXUIElementCreateSystemWide(), 5.0)

    app = AS.AXUIElementCreateApplication(pid)

    if command == "settext":
        if len(argv) < 4:
            fail("settext needs the text to type")
        return do_settext(app, resolved, argv[3], field, depth, budget) or 0

    window = front_window(app)
    if window is None:
        fail(f"{resolved} has no window open")

    if command == "tree":
        rows, truncated = walk(window, depth, budget)
        title = attr(window, AS.kAXTitleAttribute)
        print(json.dumps({
            "ok": True,
            "app": resolved,
            "window": title if isinstance(title, str) and title else None,
            "rows": rows,
            "truncated": truncated,
        }))
        return 0

    if command == "press":
        if len(argv) < 4:
            fail("press needs an element name")
        wanted = argv[3]
        element, why = find(window, wanted, depth, budget, pressable=True)
        if element is None:
            fail(why or f'no control named "{wanted}" in the front window of {resolved}')
        # A press that opens a modal or a menu can block inside the target's
        # run loop; a short per-element timeout turns that into an answer.
        AS.AXUIElementSetMessagingTimeout(element, 2.0)
        err = AS.AXUIElementPerformAction(element, AS.kAXPressAction)
        if err == AS.kAXErrorCannotComplete:
            # Dispatched, unconfirmed -- the usual reason is that the press
            # worked and opened something modal. Reported as its own state
            # rather than success or failure, because it is neither.
            print(json.dumps({
                "ok": True, "app": resolved, "pressed": wanted, "verified": False,
                "note": "the app did not confirm the press — it may have opened a dialog or menu",
            }))
            return 0
        if err != 0:
            fail(f'"{wanted}" would not accept a press (AX error {err})')
        print(json.dumps({"ok": True, "app": resolved, "pressed": wanted, "verified": True}))
        return 0

    fail(f"unknown command {command}")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
