import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Clicking things by name, not by pixel.
 *
 * The reason desktop control stopped at "scripting only" was that pixel
 * automation needs a vision model able to ground coordinates, and small local
 * VLMs cannot. The accessibility tree sidesteps that entirely: macOS already
 * exposes every button, menu item and field of every window *by name*, so
 * "click Save" needs no coordinates and no eyesight at all.
 *
 * That turns the hard problem into the one this project already knows how to
 * solve. Reading the tree produces a short closed list; acting on it is picking
 * a name out of that list and copying it back. Selection is what a ~1B-active
 * model does reliably -- it is the same transformation behind mac_recipe, the
 * router and memory extraction.
 *
 * It also fails in the right direction. A click by coordinate lands on whatever
 * happens to be at those pixels now, which after any scroll or relayout is the
 * wrong control, silently. A click by name either finds that name in the tree
 * or errors -- so a stale plan does nothing rather than something unintended.
 *
 * Two macOS permissions are involved and they are not the same one. Automation
 * (per app, error -1743) is what mac_recipe already needs. Reading the tree
 * additionally needs Accessibility, granted per launching process in System
 * Settings, and refused with error -1719. Neither can be granted from code,
 * which is correct: they are the consent that protects the user's screen.
 */

/** Cached because the recipe list is assembled synchronously in a tool
 *  description, and because probing spawns a process. Null means not yet
 *  asked -- treated as unavailable, so nothing is offered on a guess. */
let granted: boolean | null = null;

export const assistiveAccessGranted = (): boolean => granted === true;

/**
 * Ask macOS whether this process may read the accessibility tree.
 *
 * Checked up front rather than attempted-and-caught, for the same reason OCR
 * checks its language data up front: a tool that can only fail still burns the
 * model's attention deciding to call it, and the failure arrives too late to
 * pick a different approach. Note the probe answers `false` cleanly rather than
 * erroring, which is what makes it usable as a gate.
 */
export async function probeAssistiveAccess(): Promise<boolean> {
  try {
    const { stdout } = await run(
      "osascript",
      ["-e", "tell application \"System Events\" to get UI elements enabled"],
      { timeout: 10_000 },
    );
    granted = stdout.trim() === "true";
  } catch {
    // No Automation access for System Events either, which fails the same way
    // from the model's point of view: the tree cannot be read.
    granted = false;
  }
  return granted;
}

/** macOS refuses a tree read with "not allowed assistive access" and an app
 *  with -1743. Both are permission problems the message alone does not
 *  explain how to fix.
 *
 *  Matched on the phrase, never the bare number: macOS reuses -1719 for
 *  "Invalid index" too, and Calculator -- which hides its window from
 *  scripting entirely -- produced exactly that, misdiagnosed here as a
 *  missing permission the user had already granted. */
export function permissionHint(message: string): string | null {
  if (/not allowed assistive access/.test(message)) {
    granted = false;
    return (
      `macOS has not granted this app Accessibility access, which is what reading ` +
      `or clicking a window's controls needs.\n\n` +
      `Grant it in System Settings → Privacy & Security → Accessibility, for the ` +
      `app running enio, then try again.`
    );
  }
  if (/not authori[sz]ed|-?1743/.test(message)) {
    return (
      `macOS blocked this app's Automation access.\n\n` +
      `Grant it in System Settings → Privacy & Security → Automation.`
    );
  }
  return null;
}

/* ---------- resolving an app name ---------------------------------------- */

/**
 * The apps currently running with a user interface.
 *
 * This is the closed list every UI action is chosen against. Background-only
 * processes are excluded because none of them has a window to click.
 */
export async function runningApps(): Promise<string[]> {
  const { stdout } = await run(
    "osascript",
    [
      "-e",
      "tell application \"System Events\" to get name of every process whose background only is false",
    ],
    { timeout: 15_000 },
  );
  return stdout
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The running app the model meant, or an error naming the real options.
 *
 * Substring and prefix matching rather than edit distance, which is the right
 * algorithm here and not a shortcut: the model says "Chrome" for "Google
 * Chrome" and "Code" for "VSCodium", and those are seven and six edits away
 * respectively while being unambiguous as substrings. Ambiguity is refused
 * rather than guessed -- picking the wrong window to click in is precisely the
 * mistake that is expensive to undo.
 *
 * Only the *resolved* name is ever interpolated into a script. That preserves
 * what makes mac_recipe safe: the string reaching AppleScript comes from the
 * system's own process list, never from the model, so a recipe cannot be
 * talked into running something else by text the model read in a file.
 */
export function resolveApp(
  raw: string,
  apps: string[],
  /** What the list is a list of — "running" for the process list, "installed"
   *  when resolving against what is on disk. Only the error wording changes. */
  what: "running" | "installed" = "running",
): { ok: true; name: string } | { ok: false; reason: string } {
  const want = raw.trim().toLowerCase();
  const listed = `${what === "running" ? "Running" : "Installed"} apps: ${apps.join(", ")}`;
  if (!want) return { ok: false, reason: `Which app? ${listed}` };

  const exact = apps.filter((a) => a.toLowerCase() === want);
  if (exact.length === 1) return { ok: true, name: exact[0]! };

  for (const test of [
    (a: string) => a.toLowerCase().startsWith(want),
    (a: string) => a.toLowerCase().includes(want),
  ]) {
    const hits = apps.filter(test);
    if (hits.length === 1) return { ok: true, name: hits[0]! };
    if (hits.length > 1) {
      return { ok: false, reason: `"${raw}" matches ${hits.join(", ")}. Which one?` };
    }
  }

  return { ok: false, reason: `"${raw}" is not ${what}. ${listed}` };
}

/**
 * Every app on disk, by the name `open -a` accepts.
 *
 * The closed list open_app chooses from. Scanned rather than typed for the
 * same reason the model-switch list is: a name with a typo in it should be
 * refused against what actually exists, not attempted. The running-process
 * list is folded in because an app launched from a non-standard location is
 * still openable by name once running.
 */
export async function installedApps(): Promise<string[]> {
  const { readdirSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const names = new Set<string>();
  for (const dir of ["/Applications", "/System/Applications", `${homedir()}/Applications`]) {
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.endsWith(".app")) names.add(entry.slice(0, -4));
      }
    } catch {
      /* A missing directory contributes nothing. */
    }
  }
  try {
    for (const name of await runningApps()) names.add(name);
  } catch {
    /* Automation may be ungranted; the disk scan alone is still a list. */
  }
  return [...names].sort();
}

/* ---------- compiling an action into a script ---------------------------- */

/**
 * Escape for an AppleScript string literal.
 *
 * The characters with escape sequences get them rather than being dropped: a
 * raw newline would end the literal and change what the rest of the script
 * means, and the user is approving that text. The remaining control characters
 * have no sequence and no business in a name, so they go -- an invisible
 * character in an approval sheet is text that reads as one thing and runs as
 * another.
 */
function esc(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // Anything else in the control range has no escape sequence and no
    // business in a control name; leaving it in would put invisible
    // characters into text the user is being asked to approve.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "");
}

/**
 * Keys that can be pressed by name.
 *
 * Deliberately no modifier combinations. Anything worth reaching with a
 * shortcut has a menu item, and clicking the menu item is both more reliable
 * and readable in an approval sheet -- "File > Save" says what will happen in a
 * way "cmd+s" does not. This list is only the keys with no menu equivalent:
 * dismissing a dialog, moving between fields, confirming a sheet.
 */
export const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 76,
  tab: 48,
  space: 49,
  delete: 51,
  escape: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
};

export type ActionKind = "click" | "menu" | "type" | "key" | "open";

/**
 * How many levels down the accessibility tree to walk.
 *
 * Shared by the click compiler and the window_controls recipe so the thing you
 * can *see* and the thing you can *act on* are the same set — a control listed
 * but unreachable, or reachable but never listed, would be worse than either
 * limit alone. Bounded because a browser's tree is effectively unbounded, and
 * anything nested deeper than this is not something a person names out loud.
 */
export const AX_DEPTH = 8;

/** How many parents a walk may expand, and how many rows it may return.
 *  Budgets, not tuning: a real window can hold thousands of elements, and an
 *  unbudgeted walk does not come back slow, it comes back never -- the shell
 *  timeout kills it and the tool reports an empty error. A truncated list
 *  still says what is truncated; a dead tool says nothing. */
export const AX_PARENT_BUDGET = 150;
export const AX_ROW_BUDGET = 250;

/**
 * Turn a named action into the AppleScript that performs it.
 *
 * Compiled when the plan is *proposed*, not when it is approved, so what gets
 * stored and shown in the approval sheet is the exact text that will run. The
 * alternative -- storing the action and building the script at approval time --
 * would mean the user consents to a description of a script rather than to the
 * script, and this codebase already decided that distinction matters.
 */
export function compileAction(
  kind: ActionKind,
  app: string,
  value: string,
): { ok: true; script: string } | { ok: false; reason: string } {
  const target = value.trim();
  if (!target) return { ok: false, reason: `A ${kind} step needs something to act on.` };

  const a = esc(app);

  if (kind === "open") {
    // The one action whose app need not be running -- opening is how it gets
    // that way -- so the name cannot come from the process list and is model
    // text. esc() keeps it inside the AppleScript literal and `quoted form
    // of` makes it one shell word, so it cannot become a second command.
    //
    // Launched through `open -a` rather than `tell application to activate`,
    // which reads like the obvious way and fails with -600 ("Application
    // isn't running" -- from the verb whose whole job is to change that) in
    // any context not allowed to launch via Apple Events: sandboxed shells,
    // SSH sessions, some LaunchAgents. LaunchServices works in all of them.
    return {
      ok: true,
      script: `do shell script "open -a " & quoted form of "${esc(target)}"`,
    };
  }

  if (kind === "menu") {
    // "File > Save" is the shape the menu_items recipe prints, so the model
    // copies a line it was just shown rather than composing the two halves.
    const parts = target.split(">").map((p) => p.trim()).filter(Boolean);
    if (parts.length !== 2) {
      return { ok: false, reason: `A menu step looks like "File > Save". Got "${target}".` };
    }
    const [menu, item] = parts as [string, string];
    return {
      ok: true,
      script:
        `tell application "System Events" to tell process "${a}"\n` +
        `\tset frontmost to true\n` +
        `\tclick menu item "${esc(item)}" of menu "${esc(menu)}" ` +
        `of menu bar item "${esc(menu)}" of menu bar 1\n` +
        `end tell`,
    };
  }

  if (kind === "click") {
    // Walked level by level, for the reason recorded on the window_controls
    // recipe: `entire contents` looks like the way to search a whole window
    // and answers with an empty list on real ones, while a whose-clause sees
    // direct children only and every real control is nested. Batched per
    // parent and budgeted for the same reason as the recipe too -- an
    // unbudgeted per-element walk of a real window dies on the timeout.
    // Not finding the name is an explicit error: a click that matched nothing
    // would otherwise report success for having done nothing.
    return {
      ok: true,
      script:
        `tell application "System Events" to tell process "${a}"\n` +
        `\tset frontmost to true\n` +
        `\tset match to missing value\n` +
        `\tset frontier to {window 1}\n` +
        `\tset visited to 0\n` +
        `\trepeat ${AX_DEPTH} times\n` +
        `\t\tset nextF to {}\n` +
        `\t\trepeat with p in frontier\n` +
        `\t\t\tset visited to visited + 1\n` +
        `\t\t\tif visited > ${AX_PARENT_BUDGET} then exit repeat\n` +
        `\t\t\ttry\n` +
        `\t\t\t\tset kids to UI elements of p\n` +
        `\t\t\t\tset kidNames to name of every UI element of p\n` +
        `\t\t\t\trepeat with i from 1 to count of kids\n` +
        `\t\t\t\t\ttry\n` +
        `\t\t\t\t\t\tif item i of kidNames is "${esc(target)}" then\n` +
        `\t\t\t\t\t\t\tset match to item i of kids\n` +
        `\t\t\t\t\t\t\texit repeat\n` +
        `\t\t\t\t\t\tend if\n` +
        `\t\t\t\t\tend try\n` +
        `\t\t\t\t\tset end of nextF to item i of kids\n` +
        `\t\t\t\tend repeat\n` +
        `\t\t\tend try\n` +
        `\t\t\tif match is not missing value then exit repeat\n` +
        `\t\tend repeat\n` +
        `\t\tif match is not missing value then exit repeat\n` +
        `\t\tif visited > ${AX_PARENT_BUDGET} then exit repeat\n` +
        `\t\tset frontier to nextF\n` +
        `\t\tif (count of frontier) is 0 then exit repeat\n` +
        `\tend repeat\n` +
        `\tif match is missing value then error "No control named ${esc(target)} in the front window of ${a}"\n` +
        `\tclick match\n` +
        `end tell`,
    };
  }

  if (kind === "key") {
    const code = KEY_CODES[target.toLowerCase()];
    if (code === undefined) {
      return {
        ok: false,
        reason:
          `"${target}" is not a key this can press. One of: ` +
          `${Object.keys(KEY_CODES).join(", ")}. For anything else, use a menu item.`,
      };
    }
    return {
      ok: true,
      script:
        `tell application "System Events"\n` +
        `\ttell process "${a}" to set frontmost to true\n` +
        `\tdelay 0.2\n` +
        `\tkey code ${code}\n` +
        `end tell`,
    };
  }

  // type. The delay is not superstition: bringing an app forward is
  // asynchronous, and keystrokes sent before it has focus land in whatever was
  // in front a moment ago -- which is the worst possible failure for typing.
  return {
    ok: true,
    script:
      `tell application "System Events"\n` +
      `\ttell process "${a}" to set frontmost to true\n` +
      `\tdelay 0.2\n` +
      `\tkeystroke "${esc(target)}"\n` +
      `end tell`,
  };
}
