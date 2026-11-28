import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import { config } from "../config.js";
import { detectPlatform } from "../platform.js";
import { readImage } from "../vision.js";
import type { BuiltinTool, Widget } from "../types.js";
import { listSavedRecipes, osascriptFailure, proposePlan, runScript, type PlanKind, type SavedRecipe } from "../plans.js";
import { autoRunEnabled, desktopControlStored } from "../automation.js";
import { placeNewFile } from "../assets.js";
import { anyBrowser, browsersNamed, chooseBrowser, defaultBrowser, isBrowser } from "../browsers.js";
// The person's own message this turn. Kept with the account state because
// that is where a turn's words were first needed; it is not about accounts.
import { turnMessageNow, turnMessageSaid } from "../accounts.js";
import {
  assistiveAccessGranted,
  axBridge,
  axBridgeAvailable,
  AX_DEPTH,
  AX_PARENT_BUDGET,
  AX_ROW_BUDGET,
  compileAction,
  installedApps,
  KEY_CODES,
  permissionHint,
  resolveApp,
  runningApps,
  type ActionKind,
} from "./ax.js";

// Same shape as the memory tools: the turn sets the session, the tool reads it.
// A plan records which conversation asked for it, which is what lets the
// approval be traced back to a request.
let currentSessionId = "";
export const setPlanSession = (id: string) => {
  currentSessionId = id;
};

const run = promisify(execFile);

/**
 * Controlling the machine — without a GUI automation library.
 *
 * You were right to question nut.js. On a Mac the shell already reaches almost
 * everything: `osascript` drives any app with an AppleScript dictionary (Mail,
 * Calendar, Notes, Finder, Safari, Music, Reminders), `shortcuts` runs anything
 * you can build in Shortcuts, `open` launches things, `mdfind` is Spotlight,
 * `pbcopy`/`pbpaste` are the clipboard, and `screencapture` sees the screen.
 * The blocker was never a missing library — it was that the shell allowlist
 * refused those commands.
 *
 * What pixel-level automation adds over that is narrow: clicking coordinates in
 * apps with no scripting interface. It is also the least reliable path, because
 * it needs a vision model that can ground coordinates accurately, and small
 * local VLMs cannot. So: scripting first, pixels never, for now.
 *
 * (nut.js is additionally no longer freely installable — its packaged builds
 * moved to a paid private registry in 2025.)
 *
 * All of this is off unless ENIO_DESKTOP=1. AppleScript can do anything you
 * can do, so this is a genuine expansion of what a wrong tool call can cost.
 */

// Env when set, else the recorded click from the launcher's "Enable desktop
// control" button (automation.ts) — the user-shaped consent for the same
// gate. Both are user acts; neither is reachable by the model.
export const desktopEnabled = () =>
  (process.env.ENIO_DESKTOP != null || process.env.MAPLE_DESKTOP != null
    ? config.desktopEnabled
    : desktopControlStored()) && detectPlatform().startsWith("macos");

/**
 * Reading from apps needs no flag; changing them does.
 *
 * ENIO_DESKTOP was one switch over things with very different blast radii.
 * run_applescript composes arbitrary AppleScript, which can send, delete and
 * reconfigure; mac_recipe runs seven fixed `get` statements with a clamped
 * integer as the only thing the model influences. Gating them identically made
 * the safest capability here carry the cost of the most dangerous one, so
 * "show my emails" failed by default on a machine that could answer it safely.
 *
 * The invariant it comes from is that *irreversible* actions are opt-in, and a
 * read is not one. macOS still gates this independently: Automation access is
 * prompted per app and granted per launching process, which is the consent
 * that actually protects the user's data.
 */
export const recipesEnabled = () => detectPlatform().startsWith("macos");

/** Commands that become available in the shell when desktop mode is on. */
export const DESKTOP_COMMANDS = [
  "osascript",     // drive any scriptable app
  "shortcuts",     // run Shortcuts workflows
  "open",          // launch apps, files, URLs
  "screencapture", // screenshots
  "pbcopy",
  "pbpaste",
  "mdfind",        // Spotlight
  "say",
  "caffeinate",
  "networksetup",
  "system_profiler",
];

/**
 * Undo a level of JSON escaping the model applied twice.
 *
 * Maple emits tool arguments as JSON, and on AppleScript it routinely escapes
 * the quotes a second time: the skill's verbatim recipe
 * `tell application "Mail" to ...` arrives as
 * `tell application \\"Mail\\" to ...` -- backslashes and all -- and osascript
 * fails on the unknown token at character 17. The script was right; only the
 * encoding was wrong, so rejecting it wastes a turn the model actually got
 * correct.
 *
 * Only applied when the script contains no genuine string escape it could be
 * destroying. A backslash-quote inside AppleScript is legitimate when quoting
 * within a quoted string, so if the script contains any other backslash escape
 * it is left exactly as sent rather than guessed at.
 */
function unescapeQuotes(script: string): string {
  if (!script.includes('\\"')) return script;
  // Any backslash not followed by a quote means real escaping is in play.
  if (/\\(?!")/.test(script)) return script;
  return script.replace(/\\"/g, '"');
}

/**
 * The name of enio's own app, hidden for the duration of a capture.
 *
 * A screenshot answers "what is on the user's screen", and the one window
 * that is never the answer is enio's own -- it is in front precisely
 * because they just typed into it. Leaving it in is worse than noise: the
 * shot contains the conversation, so the model reads its own words back as
 * evidence about the screen, and a request to "look at what I'm doing"
 * returns a description of enio.
 *
 * By app name rather than window id: it covers every window the app has,
 * needs no Quartz binding, and works for the packaged app and a dev
 * Electron alike (both report "Enio" to System Events; the desktop passes
 * its real name in ENIO_APP_NAME rather than leaving it to a guess).
 */
export const ownAppName = (): string =>
  (process.env.ENIO_APP_NAME ?? "Enio").replace(/[^A-Za-z0-9 ._-]/g, "").trim() || "Enio";

/** Hides enio, runs the capture, and puts it back -- always, including on
 *  failure. A window left hidden by a crashed screenshot would look like the
 *  app had quit. Hiding needs Automation permission; without it the capture
 *  simply happens with the window in frame, because a screenshot that
 *  refuses is worse than one with enio in the corner. */
async function withoutOwnWindow<T>(capture: () => Promise<T>): Promise<T> {
  const name = ownAppName();
  const visibility = async (visible: boolean) => {
    await run(
      "osascript",
      ["-e", `tell application "System Events" to set visible of process "${name}" to ${visible}`],
      { timeout: 5_000 },
    );
  };

  let hidden = false;
  try {
    await visibility(false);
    hidden = true;
    // The hide is animated; capturing immediately catches the window
    // mid-fade, which is the artifact this whole function exists to avoid.
    await new Promise((resolve) => setTimeout(resolve, 350));
  } catch {
    // Not running (CLI-only), or Automation not granted. Capture anyway.
  }

  try {
    return await capture();
  } finally {
    if (hidden) await visibility(true).catch(() => {});
  }
}

/**
 * The frontmost window's rectangle, read from the accessibility tree.
 *
 * `screencapture -w` is INTERACTIVE -- it waits for the user to click a
 * window, so the old window:true path hung until the timeout and then
 * reported a capture failure. A rect from the AX tree is the non-interactive
 * equivalent. Coordinates here are geometry for a crop, not a click target,
 * so this does not weaken the click-by-name rule.
 */
async function frontWindowRect(): Promise<string | null> {
  try {
    const { stdout } = await run(
      "osascript",
      [
        "-e",
        `tell application "System Events"
           set frontApp to first process whose frontmost is true
           tell frontApp
             if (count of windows) is 0 then return ""
             set {x, y} to position of front window
             set {w, h} to size of front window
             return (x as text) & "," & (y as text) & "," & (w as text) & "," & (h as text)
           end tell
         end tell`,
      ],
      { timeout: 5_000 },
    );
    const rect = stdout.trim();
    return /^-?\d+,-?\d+,\d+,\d+$/.test(rect) ? rect : null;
  } catch {
    return null;
  }
}

const screenshotTool: BuiltinTool = {
  name: "take_screenshot",
  description:
    "Capture the screen and read what's on it. Use when the user refers to something they can see, or to check the result of something you did.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "Optional. What to look for — 'which window is in front?' gets a far better answer than a general description.",
      },
      window: {
        type: "boolean",
        description: "Capture only the frontmost window rather than the whole screen.",
      },
    },
    required: [],
  },
  async run(args) {
    // An asset of this turn: beside whatever else the turn makes, with the
    // request that asked for it, instead of one more screen-<number>.png in
    // the workspace root with nothing saying what it was a screenshot of.
    const file = placeNewFile(`screen-${Date.now()}.png`);
    let note = "";
    try {
      await withoutOwnWindow(async () => {
        // -x suppresses the shutter sound. Window mode is a rect read from
        // the AX tree, because screencapture's own -w waits for a click.
        const flags = ["-x"];
        if (args.window) {
          // Read AFTER enio is hidden: the frontmost window is then the one
          // the user was actually looking at, not the window they typed the
          // request into.
          const rect = await frontWindowRect();
          if (rect) flags.push(`-R${rect}`);
          else note = "\n\n(Captured the whole screen — the frontmost window's bounds were unreadable.)";
        }
        await run("screencapture", [...flags, file], { timeout: 15_000 });
      });
    } catch (err) {
      return (
        `Could not capture the screen: ${(err as Error).message}\n` +
        `macOS needs Screen Recording permission for the terminal running enio ` +
        `(System Settings → Privacy & Security → Screen Recording).`
      );
    }

    // Straight into the vision path, so the model gets text rather than a file
    // path it cannot look at.
    const reading = await readImage(file, args.question ? String(args.question) : undefined);
    return {
      text: `Screenshot saved to ${file}${note}\n\n${reading.text}`,
      // How the screen was actually read, said to the user only. Without it a
      // reply like "no error message is visible" reads as the agent being
      // unable to see, when what happened is that OCR read the text and
      // nothing looked at the pixels.
      ...(reading.note ? { notice: reading.note } : {}),
      // The text above is a vision-model READING of the screen; the widget
      // shows the actual pixels so the user can check it. basename() is
      // correct because the file was just written into the workspace root,
      // which is where clients resolve relative paths.
      widget: {
        type: "image",
        path: basename(file),
        ...(args.question ? { caption: String(args.question) } : {}),
      },
    };
  },
};

const appleScriptTool: BuiltinTool = {
  name: "run_applescript",
  description:
    "Run AppleScript to control a Mac app — read Mail, add a Calendar event, create a Note, query Music, control Finder. Prefer this over shell commands for anything involving an app's own data.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      script: {
        type: "string",
        description:
          'The AppleScript source. E.g. \'tell application "Notes" to make new note with properties {name:"Ideas"}\'',
      },
    },
    required: ["script"],
  },
  async run(args) {
    const script = unescapeQuotes(String(args.script ?? "").trim());
    if (!script) return "Error: no script given.";

    try {
      const { stdout, stderr } = await run("osascript", ["-e", script], {
        timeout: config.shellTimeoutMs,
        maxBuffer: 4_000_000,
      });
      const output = (stdout || stderr).trim();
      return output || "(ran successfully, no output)";
    } catch (err) {
      const message = osascriptFailure(err);
      // Automation permission errors are the common failure and the message
      // alone doesn't say what to do about it.
      if (/not authori[sz]ed|1743|-1743/.test(message)) {
        return (
          `AppleScript was blocked by macOS privacy settings.\n${message}\n\n` +
          `Grant it in System Settings → Privacy & Security → Automation, ` +
          `for the terminal running enio.`
        );
      }
      return `AppleScript failed: ${message}`;
    }
  },
};

/**
 * Named, tested AppleScript that the model selects rather than writes.
 *
 * Authoring was the failure. Given the skill's verbatim recipe the model still
 * could not deliver it: it double-escaped the quotes, then misspelled the tool
 * as run_appLEScriпт with Cyrillic homoglyphs, then emitted __enio_ prefixes,
 * degrading further with each retry. Every one of those is a generation
 * problem, and this project's answer to a generation problem is to make it a
 * choice from a short closed list instead -- which is the one thing a model
 * this size does reliably.
 *
 * So the scripts live here, already correct, and the model picks a name and a
 * count. Nothing it emits is interpolated into the script except an integer,
 * which is also why this cannot be talked into running arbitrary AppleScript
 * by something it reads in a file.
 *
 * Every script here was run on a real machine before being added. Adding one
 * means testing it the same way, not writing what ought to work.
 */
interface Recipe {
  summary: string;
  script: (ctx: { count: number; app: string }) => string;
  /** The one app this recipe reads, when it reads one. Said at the top of
   *  the result, and what an `app` argument naming something else is held
   *  against: asked for mail "in Safari" the model ran recent_emails with
   *  app "Safari", the argument was ignored, and Mail's inbox was reported
   *  as what the browser showed. */
  reads?: string;
  /** Rows that open with "N days ago": the newest is checked, so that a
   *  mailbox that stopped syncing months back is not read out as today's. */
  dated?: true;
  /** Needs an app; the *resolved* name is interpolated, never the raw input. */
  needsApp?: true;
  /** Reads the accessibility tree, so it is withheld until macOS allows that. */
  needsAx?: true;
  /** Preferred over the AppleScript when the direct bridge is available: it
   *  reaches apps System Events cannot see at all. */
  direct?: (ctx: { count: number; app: string }) => Promise<string | null>;
}

const RECIPES: Record<string, Recipe> = {
  // Every Mail recipe opens with the same line, counted by Mail: how many
  // messages the inbox holds and how old the newest is. It is what says an
  // account stopped syncing, and it has to come from the whole inbox: the
  // newest UNREAD message being a month old says nothing about that.
  recent_emails: {
    summary: "The most recent messages in the Mail app's inbox: how old, read or unread, sender, subject",
    reads: "Mail",
    dated: true,
    // Age in days computed by Mail itself, not a date string to parse: the
    // string is in the machine's locale. And never past the end of the
    // inbox: "messages 1 thru 5" of an inbox of three is an error.
    script: ({ count }) =>
      `tell application "Mail"\n` +
      `\tset out to {}\n` +
      `\tset today to current date\n` +
      `\tset total to count of messages of inbox\n` +
      `\tif total > 0 then\n` +
      `\t\tset head to "Inbox: " & total & " messages, newest " & ((today - (date received of message 1 of inbox)) div days) & " days ago"\n` +
      `\telse\n` +
      `\t\tset head to "Inbox: 0 messages"\n` +
      `\tend if\n` +
      `\tset upto to ${count}\n` +
      `\tif total < upto then set upto to total\n` +
      `\trepeat with i from 1 to upto\n` +
      `\t\tset m to message i of inbox\n` +
      `\t\tset age to ((today - (date received of m)) div days)\n` +
      `\t\tif read status of m then\n` +
      `\t\t\tset seen to "read"\n` +
      `\t\telse\n` +
      `\t\t\tset seen to "UNREAD"\n` +
      `\t\tend if\n` +
      `\t\tset end of out to (age as string) & " days ago | " & seen & " | " & (sender of m) & " | " & (subject of m)\n` +
      `\tend repeat\n` +
      `\tset AppleScript's text item delimiters to linefeed\n` +
      `\treturn head & linefeed & (out as string)\n` +
      `end tell`,
  },
  unread_emails: {
    summary: "The unread messages in the Mail app's inbox, newest first: how old, sender, subject",
    reads: "Mail",
    dated: true,
    script: ({ count }) =>
      `tell application "Mail"\n` +
      `\tset out to {}\n` +
      `\tset today to current date\n` +
      `\tset total to count of messages of inbox\n` +
      `\tif total > 0 then\n` +
      `\t\tset head to "Inbox: " & total & " messages, newest " & ((today - (date received of message 1 of inbox)) div days) & " days ago"\n` +
      `\telse\n` +
      `\t\tset head to "Inbox: 0 messages"\n` +
      `\tend if\n` +
      `\tset waiting to (messages of inbox whose read status is false)\n` +
      `\tset unreadTotal to count of waiting\n` +
      `\tset upto to ${count}\n` +
      `\tif unreadTotal < upto then set upto to unreadTotal\n` +
      `\trepeat with i from 1 to upto\n` +
      `\t\tset m to item i of waiting\n` +
      `\t\tset age to ((today - (date received of m)) div days)\n` +
      `\t\tset end of out to (age as string) & " days ago | UNREAD | " & (sender of m) & " | " & (subject of m)\n` +
      `\tend repeat\n` +
      `\tset AppleScript's text item delimiters to linefeed\n` +
      `\treturn head & linefeed & (unreadTotal as string) & " unread" & linefeed & (out as string)\n` +
      `end tell`,
  },
  unread_count: {
    summary: "How many unread messages are in the Mail app's inbox",
    reads: "Mail",
    dated: true,
    script: () =>
      `tell application "Mail"\n` +
      `\tset today to current date\n` +
      `\tset total to count of messages of inbox\n` +
      `\tif total > 0 then\n` +
      `\t\tset head to "Inbox: " & total & " messages, newest " & ((today - (date received of message 1 of inbox)) div days) & " days ago"\n` +
      `\telse\n` +
      `\t\tset head to "Inbox: 0 messages"\n` +
      `\tend if\n` +
      `\treturn head & linefeed & ((unread count of inbox) as string) & " unread"\n` +
      `end tell`,
  },
  latest_email_body: {
    summary: "Full text of the single most recent message in the Mail app",
    reads: "Mail",
    dated: true,
    script: () =>
      `tell application "Mail"\n` +
      `\tset today to current date\n` +
      `\tset total to count of messages of inbox\n` +
      `\tif total > 0 then\n` +
      `\t\tset head to "Inbox: " & total & " messages, newest " & ((today - (date received of message 1 of inbox)) div days) & " days ago"\n` +
      `\telse\n` +
      `\t\tset head to "Inbox: 0 messages"\n` +
      `\tend if\n` +
      `\tif total = 0 then return head\n` +
      `\tset m to message 1 of inbox\n` +
      `\tif read status of m then\n` +
      `\t\tset seen to "read"\n` +
      `\telse\n` +
      `\t\tset seen to "UNREAD"\n` +
      `\tend if\n` +
      `\treturn head & linefeed & seen & " | " & (sender of m) & " | " & (subject of m) & linefeed & linefeed & (content of m)\n` +
      `end tell`,
  },
  todays_events: {
    summary: "Events starting today in the Calendar app",
    reads: "Calendar",
    script: () =>
      `tell application "Calendar"\n` +
      `\tset d to current date\n` +
      `\tset d's hours to 0\n` +
      `\tset d's minutes to 0\n` +
      `\tset d's seconds to 0\n` +
      `\tset out to {}\n` +
      `\trepeat with e in (every event of calendar 1 whose start date ≥ d and start date < d + 1 * days)\n` +
      `\t\tset end of out to (summary of e) & " at " & (start date of e as string)\n` +
      `\tend repeat\n` +
      `\treturn out\n` +
      `end tell`,
  },
  open_reminders: {
    summary: "Reminders not yet completed",
    script: () => `tell application "Reminders" to get name of (reminders whose completed is false)`,
  },
  recent_notes: {
    summary: "Titles of the most recent notes",
    script: ({ count }) => `tell application "Notes" to get name of notes 1 thru ${count}`,
  },
  desktop_files: {
    summary: "Files on the Desktop",
    script: () => `tell application "Finder" to get name of items of desktop`,
  },

  /* The accessibility tier: what is on screen, by name. These are what turn
     "click the Save button" from a coordinate-grounding problem into picking a
     line out of a list. */

  running_apps: {
    summary: "Which apps are open, by name — check here before acting on one",
    script: () =>
      `tell application "System Events" to get name of every process whose background only is false`,
  },
  window_controls: {
    summary: "Buttons and fields in an app's front window, by name (needs app)",
    needsApp: true,
    needsAx: true,
    // Tried through the direct AX bridge first. Not a preference -- a
    // capability difference: Calculator answers System Events with zero
    // windows and the bridge with twenty-three named buttons. Null falls
    // through to the AppleScript below, which is what every app that already
    // worked has been tested against.
    direct: async ({ app }) => {
      if (!axBridgeAvailable()) return null;
      const out = await axBridge(["tree", app]);
      if (!out.ok || !out.rows) return null;
      const rows = out.rows.join("\n");
      return out.truncated ? `${rows}\n… truncated.` : rows;
    },
    // Walked breadth-first, level by level, rather than with `entire contents`.
    // That reads like the obvious way to get the whole tree and silently
    // returns an empty list for real windows -- Notes answers 0 for it while
    // `button 1 of window 1` is right there. A whose-clause is no good either,
    // since it sees direct children only and every real control is nested in a
    // toolbar or group. Descending a level at a time is the one that works.
    //
    // Batched per PARENT -- `name of every UI element` is one Apple Event for
    // the whole sibling row -- and budgeted. The first walk asked per element,
    // three events each; a real Notes window has thousands of elements, and
    // the walk blew the shell timeout and surfaced as an empty error. Events
    // now scale with parents visited, and the budget makes the worst case a
    // truncated list rather than a dead tool.
    script: ({ app }) =>
      `tell application "System Events" to tell process "${app}"\n` +
      // "No window" is ambiguous from AppleScript: Calculator has a window on
      // screen and still reports none -- some system apps hide their windows
      // from scripting entirely. The message says what still works, because
      // keystrokes go to the frontmost app without touching the window tree.
      `\tif not (exists window 1) then return "No window is visible to scripting in ${app}. If a window is on screen, this app is one System Events cannot see; the accessibility bridge reaches it, and type_text and press steps work regardless."\n` +
      `\tset out to {}\n` +
      `\tset frontier to {window 1}\n` +
      `\tset visited to 0\n` +
      // Bounded: an unbounded descent into a browser's tree is unbounded work,
      // and a control deeper than this is one nobody is naming out loud.
      `\trepeat ${AX_DEPTH} times\n` +
      `\t\tset nextF to {}\n` +
      `\t\trepeat with p in frontier\n` +
      `\t\t\tset visited to visited + 1\n` +
      `\t\t\tif visited > ${AX_PARENT_BUDGET} then exit repeat\n` +
      `\t\t\ttry\n` +
      `\t\t\t\tset kids to UI elements of p\n` +
      `\t\t\t\tset kidNames to name of every UI element of p\n` +
      `\t\t\t\tset kidRoles to role description of every UI element of p\n` +
      `\t\t\t\trepeat with i from 1 to count of kids\n` +
      `\t\t\t\t\ttry\n` +
      `\t\t\t\t\t\tset n to item i of kidNames\n` +
      `\t\t\t\t\t\tif n is not missing value and n is not "" then\n` +
      `\t\t\t\t\t\t\tset end of out to (item i of kidRoles) & ": " & n\n` +
      `\t\t\t\t\t\tend if\n` +
      `\t\t\t\t\tend try\n` +
      `\t\t\t\t\tset end of nextF to item i of kids\n` +
      `\t\t\t\tend repeat\n` +
      `\t\t\tend try\n` +
      `\t\tend repeat\n` +
      `\t\tif visited > ${AX_PARENT_BUDGET} then exit repeat\n` +
      `\t\tif (count of out) > ${AX_ROW_BUDGET} then exit repeat\n` +
      `\t\tset frontier to nextF\n` +
      `\t\tif (count of frontier) is 0 then exit repeat\n` +
      `\tend repeat\n` +
      `\tset AppleScript's text item delimiters to linefeed\n` +
      `\treturn out as text\n` +
      `end tell`,
  },
  menu_items: {
    summary: "An app's menu commands as 'File > Save' lines (needs app)",
    needsApp: true,
    needsAx: true,
    // Printed in the exact shape a menu action is written in, so acting on one
    // is copying a line back rather than composing it from two halves.
    //
    // Menu bar item 1 is the Apple menu, and it is skipped. It is not the
    // app's own commands, it is identical for every app, and it is where Shut
    // Down and Restart live -- so including it padded a closed list meant for
    // choosing from with a dozen irrelevant entries, two of which end the
    // user's session.
    script: ({ app }) =>
      `tell application "System Events" to tell process "${app}"\n` +
      `\tset out to {}\n` +
      `\tset bar to menu bar items of menu bar 1\n` +
      `\trepeat with idx from 2 to (count of bar)\n` +
      `\t\tset m to item idx of bar\n` +
      `\t\tset mn to name of m\n` +
      `\t\ttry\n` +
      `\t\t\trepeat with i in menu items of menu 1 of m\n` +
      `\t\t\t\tset n to name of i\n` +
      `\t\t\t\tif n is not missing value and n is not "" then set end of out to mn & " > " & n\n` +
      `\t\t\tend repeat\n` +
      `\t\tend try\n` +
      `\tend repeat\n` +
      `\tset AppleScript's text item delimiters to linefeed\n` +
      `\treturn out as text\n` +
      `end tell`,
  },
};

/**
 * Every recipe's script, filled in with a stand-in app and count.
 *
 * Exported for the test that runs each one through osacompile. That does not
 * prove a recipe returns the right thing -- only a real machine does, which is
 * the standing rule for adding one -- but it does catch the failure that would
 * otherwise surface as the model being blamed for a tool that was malformed
 * before it ever chose it.
 */
export const recipeScripts = (): Array<[string, string]> =>
  Object.entries(RECIPES).map(([name, r]) => [name, r.script({ count: 5, app: "Finder" })]);

/**
 * The built-in recipes, described for a person rather than for the model.
 *
 * These are code and cannot be edited, but they must still be *visible*: the
 * recipe list is the closed set the model chooses from, and curating a set you
 * can only see half of is guesswork. The script is included because it is the
 * honest answer to "what does this actually do".
 */
export const builtinRecipes = (): Array<{
  name: string;
  summary: string;
  script: string;
  needsApp: boolean;
  needsAx: boolean;
  available: boolean;
}> =>
  Object.entries(RECIPES).map(([name, r]) => ({
    name,
    summary: r.summary,
    script: r.script({ count: 5, app: "<app>" }),
    needsApp: r.needsApp === true,
    needsAx: r.needsAx === true,
    available: !r.needsAx || assistiveAccessGranted(),
  }));

/** Saved recipes are only offered when desktop mode is on, because that is the
 *  switch that governs running one — a name in the description the model
 *  cannot actually use is a dead end that costs it a turn to discover. */
const savedRecipesAvailable = () => (desktopEnabled() ? listSavedRecipes() : []);

/** Recipes reading the accessibility tree are hidden until macOS permits it.
 *  A tool the model can only fail with still costs it the attention of
 *  choosing, and the failure comes too late to try another way. */
const availableRecipes = (): Array<[string, Recipe]> =>
  Object.entries(RECIPES).filter(([, r]) => !r.needsAx || assistiveAccessGranted());

/** Long trees are truncated rather than left to fill the window: the point of
 *  the list is to be chosen from, and a list past a few hundred lines has
 *  stopped being one. */
function capped(text: string, limit = 6000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… truncated. Narrow it down or ask about one part of the window.`;
}

/**
 * Where a reading came from, and how fresh it is, said above the rows.
 *
 * The reply has nowhere else to learn either. Asked for unread mail "in
 * the browser", the operator read the Mail app and reported five subjects
 * as today's unread: the newest was 173 days old and three had been read.
 * The app had stopped syncing months before and nothing in the result
 * said so. Staleness is a count the script already made (the leading
 * "N days ago"), so it is stated here and not left to be noticed.
 */
/**
 * How many days old the newest message in the inbox is, or null when the
 * result does not say. Read from the line the script opens with, which
 * counts the whole inbox. Not from the rows: for unread_emails those are
 * the unread ones only, and "the newest message there is 30 days old" was
 * said of a healthy inbox with two old newsletters left unread.
 */
function newestAge(recipe: Pick<Recipe, "dated">, text: string): number | null {
  if (!recipe.dated) return null;
  const head = /^Inbox: \d+ messages?, newest (-?\d+) days ago$/m.exec(text);
  return head ? Number(head[1]) : null;
}

/**
 * The same two facts for the person, as a notice beside the reply. The
 * line above is for the model, and replayed on the 4B with it in place
 * the reply gave the ages and still called the Mail app's inbox "your
 * email inbox" to someone who had asked about their browser. A notice is
 * the harness speaking, so it is said whether or not the model says it.
 */
export function sourceNotice(recipe: Pick<Recipe, "reads" | "dated">, text: string): string {
  const newest = newestAge(recipe, text);
  return (
    `Read the ${recipe.reads} app on this Mac, not a web page.` +
    (newest !== null && newest > 2 ? ` The newest message in that inbox is ${newest} days old.` : "")
  );
}

export function sourceLine(recipe: Pick<Recipe, "reads" | "dated">, text: string): string {
  const from = `From the ${recipe.reads} app on this Mac — not a web page, and not a connected account.`;
  const newest = newestAge(recipe, text);
  if (newest === null) return from;
  return newest > 2
    ? `${from} The newest message in that inbox is ${newest} days old: the ${recipe.reads} app is not showing recent mail, so say how old this is and do not present it as new.`
    : from;
}

/**
 * A proposed plan, as the person reads it in the thread.
 *
 * Said by the harness, with the steps in it: the card under the reply is
 * where the plan is run, changed or discarded, but a surface with no card
 * (the terminal, an API client) still has to show what would happen.
 */
export function planReply(summary: string, steps: Array<{ summary: string }>): string {
  return (
    `Here is what I would do. Nothing has run yet.\n\n${summary}\n` +
    steps.map((s, i) => `${i + 1}. ${s.summary}`).join("\n") +
    `\n\nIt is waiting for you: run it, change it, discard it, or have me try again.`
  );
}

/**
 * Offer a script the person saved, as a plan of one step waiting to run.
 *
 * The same thing whether the model picked the script by name or the
 * harness matched the request to it (agent.ts): a card that says which
 * script it is and can be run with one press, because this text has run
 * before and was kept by the person now reading it.
 */
export function offerSavedRecipe(
  saved: SavedRecipe,
  request: string | null,
): { reply: string; widget: Extract<Widget, { type: "plan" }> } {
  const summary = saved.summary || `Run the ${saved.name} script`;
  const steps = [{ summary: saved.summary || saved.name, script: saved.script, kind: saved.kind }];
  const plan = proposePlan({
    sessionId: currentSessionId || null,
    summary,
    kind: saved.kind,
    steps,
    request,
    source: `saved:${saved.name}`,
  });
  return {
    reply:
      `You saved a script for this: ${saved.name}. Nothing has run yet.\n\n${summary}\n\n` +
      `It is waiting for you: run it, look at it first, or have me try again and write a new plan.`,
    widget: { type: "plan", id: plan.id, summary, steps, request: plan.request, source: plan.source },
  };
}

const recipeTool: BuiltinTool = {
  name: "mac_recipe",
  // Rebuilt on read so a recipe saved this session is offered on the next turn
  // without a restart -- the whole point of saving one.
  get description(): string {
    const builtin = availableRecipes().map(([name, r]) => `${name} (${r.summary})`);
    const saved = savedRecipesAvailable().map((r) => `${r.name} (${r.summary})`);
    return (
      "Read something from a Mac app using a tested script. Use this rather than writing AppleScript. Recipes: " +
      [...builtin, ...saved].join("; ")
    );
  },
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      recipe: {
        type: "string",
        description: "Which recipe to run, by name.",
      },
      app: {
        type: "string",
        description:
          "Which app, for recipes that say they need one. Must be running — use running_apps to see.",
      },
      count: {
        type: "number",
        description: "How many items to return, where the recipe takes a count. Defaults to 5.",
      },
    },
    required: ["recipe"],
  },
  async run(args) {
    const name = String(args.recipe ?? "").trim();
    const saved = listSavedRecipes().find((r) => r.name === name);
    const recipe: Recipe | undefined =
      RECIPES[name] ?? (saved ? { summary: saved.summary, script: () => saved.script } : undefined);
    if (!recipe) {
      const all = [...availableRecipes().map(([n]) => n), ...savedRecipesAvailable().map((r) => r.name)];
      return `No recipe named "${name}". Available: ${all.join(", ")}`;
    }
    // A saved recipe is not a built-in. The reason built-ins need no flag is
    // that they are audited reads; a saved one is arbitrary script that a
    // person wrote or approved, and since plans can carry clicks, keystrokes
    // and now shell and Python it may well change something. Running that
    // ungated would put an irreversible action behind no switch at all.
    if (saved && !RECIPES[name]) {
      if (!desktopEnabled()) {
        return (
          `"${name}" is a saved recipe, which can change things, so it needs desktop ` +
          `mode. Start enio with ENIO_DESKTOP=1 to use it.`
        );
      }

      // Vouched for, and unattended running is switched on: this is the one
      // path that acts without asking, and it exists because being asked to
      // re-approve the same script forever is how an approval stops being
      // read. Everything else -- an unmarked recipe, auto off -- goes to the
      // sheet instead of running silently, which is stricter than before.
      if (saved.safe && autoRunEnabled()) {
        const out = await runScript(saved.script, saved.kind);
        return out.ok
          ? capped(out.output) || "(nothing to report)"
          : `"${name}" failed: ${out.output}`;
      }

      const offered = offerSavedRecipe(saved, turnMessageSaid());
      return {
        text:
          `"${name}" is saved but not marked safe to run on its own` +
          `${autoRunEnabled() ? "" : ", and automatic running is off"}, so it is ` +
          `waiting for the user to approve it. Call nothing else.`,
        widget: offered.widget,
        final: offered.reply,
      };
    }
    if (recipe.needsAx && !assistiveAccessGranted()) {
      return (
        `"${name}" needs Accessibility access, which macOS has not granted this app.\n\n` +
        `Turn it on in System Settings → Privacy & Security → Accessibility, for the ` +
        `app running enio.`
      );
    }

    // Clamped and integer-only: with an app name this is no longer the *only*
    // thing the model influences, but it is still the only thing it influences
    // freely.
    const raw = Number(args.count ?? 5);
    const count = Number.isFinite(raw) ? Math.min(50, Math.max(1, Math.floor(raw))) : 5;

    // A recipe that reads one app, asked for another: it cannot, and
    // running it anyway answers a different question under the same name.
    // Held to the app's own name, not to a shared substring: "Gmail" and
    // "Proton Mail" hold "mail" and are not the Mail app. A placeholder is
    // no argument at all.
    const elsewhere = String(args.app ?? "").trim();
    const asked = elsewhere
      .toLowerCase()
      .replace(/^the\s+/, "")
      .replace(/^apple\s+/, "")
      .replace(/(?:\s+app|\.app)$/, "");
    if (recipe.reads && asked && !/^(?:null|none|n\/a|undefined)$/.test(asked) && asked !== recipe.reads.toLowerCase()) {
      return {
        text:
          `${name} reads the ${recipe.reads} app on this Mac. It cannot read ${elsewhere}, and nothing was read. ` +
          `Tell the user that: what a web page shows is not something a recipe can read. ` +
          `Offer the ${recipe.reads} app instead, or their connected account through the ${recipe.reads === "Mail" ? "mail" : "planner"} agent.`,
        notice: `Nothing was read: ${name} reads the ${recipe.reads} app, not ${elsewhere}.`,
      };
    }

    // The resolved name goes into the script, never what the model wrote. That
    // is what keeps the interpolation safe: the string comes from the system's
    // own process list, so no text the model read can steer it elsewhere.
    let app = "";
    if (recipe.needsApp) {
      let running: string[];
      try {
        running = await runningApps();
      } catch (err) {
        const message = osascriptFailure(err);
        return permissionHint(message) ?? `Could not list running apps: ${message}`;
      }
      const resolved = resolveApp(String(args.app ?? ""), running);
      if (!resolved.ok) return resolved.reason;
      app = resolved.name;
    }

    // The direct path first when the recipe has one and the bridge is up; a
    // null answer means "could not", not "nothing", and falls through.
    if (recipe.direct) {
      try {
        const direct = await recipe.direct({ count, app });
        if (direct !== null) return capped(direct) || "(nothing to report)";
      } catch {
        /* fall through to AppleScript */
      }
    }

    try {
      const { stdout, stderr } = await run("osascript", ["-e", recipe.script({ count, app })], {
        timeout: config.shellTimeoutMs,
        maxBuffer: 4_000_000,
      });
      const text = capped((stdout || stderr).trim());
      // An empty reading still says where it looked: "(nothing to report)"
      // alone reads as "you have no mail".
      if (!text) {
        return recipe.reads
          ? { text: `${sourceLine(recipe, "")}\n\n(nothing there)`, notice: sourceNotice(recipe, "") }
          : "(nothing to report)";
      }
      return recipe.reads
        ? { text: `${sourceLine(recipe, text)}\n\n${text}`, notice: sourceNotice(recipe, text) }
        : text;
    } catch (err) {
      const message = osascriptFailure(err);
      return permissionHint(message) ?? `Could not read that: ${message}`;
    }
  },
};


/** The action keys a step may carry, and the compiler verb each maps to.
 *  Named as verbs and kept flat -- one key whose presence says what the step
 *  is -- because a nested discriminated union is exactly the JSON a model this
 *  size gets wrong. */
const STEP_ACTIONS: Array<[key: string, kind: ActionKind]> = [
  ["open", "open"],
  ["click", "click"],
  ["menu", "menu"],
  ["type_text", "type"],
  ["press", "key"],
];

/** The app's own executable, not anything under its bundle: a widget or
 *  share extension runs from inside Notes.app with Notes closed, and
 *  matched on the bundle alone a cold launch was reported as "already
 *  open" for sixteen of thirty stock apps. */
const processPattern = (name: string) => `/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.app/Contents/MacOS/`;

/** Asked of the process table: "already open" is a fact about the machine
 *  the person can check. */
async function appIsRunning(name: string): Promise<boolean> {
  try {
    // -a: pgrep leaves out its own ancestors unless told not to, and the
    // terminal or editor Enio was started from is one. Asked about it,
    // Enio said it was not open and proposed opening it.
    await run("pgrep", ["-a", "-f", processPattern(name)], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Which installed app a name means, for opening.
 *
 * One answer for the tool and for a plan's `open` step: a plan used to
 * take the name as the model wrote it, so "the browser" in a plan was
 * handed to `open -a` as those two words while the tool beside it knew to
 * ask which browser is the person's.
 */
async function resolveOpenTarget(asked: string): Promise<{ ok: true; name: string; note: string } | { ok: false; reason: string }> {
  const apps = await installedApps();
  let wanted = asked;
  let note = "";
  // A browser is the person's, not the model's pick (browsers.ts). The
  // running list is asked for only here: it needs Automation, and an
  // ungranted machine still has a default browser to go by.
  // By the short name too: the model writes "Chrome" and "Edge", not
  // the name on the bundle.
  // Not when what was written is already an installed app's whole name:
  // "Firefox Nightly" holds "firefox" and is not Firefox.
  const exact = apps.some((a) => a.toLowerCase() === wanted.trim().toLowerCase());
  const short = anyBrowser(wanted) || exact ? [] : browsersNamed(`open ${wanted}`);
  if (short.length === 1 && wanted.trim().split(/\s+/).length <= 2) wanted = short[0]!;
  if (anyBrowser(wanted) || isBrowser(wanted)) {
    let running: string[] = [];
    try {
      running = await runningApps();
    } catch {
      /* no list: the default decides */
    }
    const choice = chooseBrowser({
      asked: wanted,
      message: turnMessageNow(),
      running,
      installed: apps,
      dflt: await defaultBrowser(),
    });
    if (choice.name === null) return { ok: false, reason: choice.why };
    if (choice.why) note = ` (${choice.why}${isBrowser(wanted) && choice.name.toLowerCase() !== wanted.trim().toLowerCase() ? `, not ${wanted.trim()}` : ""})`;
    wanted = choice.name;
  }
  const resolved = resolveApp(wanted, apps, "installed");
  return resolved.ok ? { ok: true, name: resolved.name, note } : { ok: false, reason: resolved.reason };
}

const openAppTool: BuiltinTool = {
  name: "open_app",
  description:
    "Open a Mac app by name — Spotify, Calendar, Notes. Call it every time the user asks to open or show an app: it is safe when the app is already running (it just comes to the front), and apps open and close outside this conversation, so never answer from memory. For anything beyond opening, use mac_recipe or propose_plan.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      app: {
        type: "string",
        description: 'The app\'s name, e.g. "Spotify". Partial names resolve: "chrome" finds Google Chrome.',
      },
    },
    required: ["app"],
  },
  /**
   * Direct, not via propose_plan, and ungated like mac_recipe. The gate is
   * about irreversibility, and opening an app is the most reversible action
   * there is -- quitting it undoes it. What keeps it safe is the same thing
   * that keeps recipes safe: the name handed to `open` comes from resolving
   * against the system's own installed-apps list, never from the model, so
   * text the model read somewhere cannot steer this into running anything
   * else. LaunchServices rather than an Apple Event, for the -600 reason
   * recorded on the `open` plan action.
   */
  async run(args) {
    const target = await resolveOpenTarget(String(args.app ?? ""));
    if (!target.ok) return target.reason;
    const resolved = { name: target.name };
    const note = target.note;
    const pattern = processPattern(resolved.name);
    const wasOpen = await appIsRunning(resolved.name);

    // The person did not ask for this app to be opened: the model chose
    // to, on the way to something else. The harness says so on the call
    // (agent.ts, `asked`), never the model. Nothing runs here.
    if (args.asked === false) {
      // Already open: there is nothing to do and nothing to approve, and
      // the model can go on to read from it. Not brought to the front --
      // that is a change to the screen nobody asked for.
      if (wasOpen) {
        return (
          `${resolved.name}${note} is already open. Nothing was opened or brought forward: the user did not ask for that. ` +
          `Carry on with what they asked: read from it, or propose the plan.`
        );
      }
      const summary = `Open ${resolved.name}${note}`;
      const compiled = compileAction("open", resolved.name, resolved.name);
      if (!compiled.ok) return compiled.reason;
      const steps = [{ summary, script: compiled.script }];
      const request = turnMessageSaid();
      const plan = proposePlan({ sessionId: currentSessionId || null, summary, kind: "applescript", steps, request, source: "open" });
      return {
        text:
          `Not opened. The user did not ask to open ${resolved.name}, so it is proposed as a plan and waiting for them to run it. ` +
          `Do not call another tool.`,
        widget: { type: "plan", id: plan.id, summary, steps, request: plan.request, source: "open" },
        final:
          `To do that I would open ${resolved.name}${note}. It is not open, and you did not ask me to open it, so nothing has run: ` +
          `it is waiting for you below. Run it and say "go on", or discard it.`,
      };
    }

    try {
      await run("open", ["-a", resolved.name], { timeout: 15_000 });
    } catch (err) {
      return `Could not open ${resolved.name}: ${(err as Error & { stderr?: string }).stderr?.trim() || (err as Error).message}`;
    }
    if (wasOpen) return `${resolved.name}${note} was already open — brought to the front.`;

    // `open` exiting 0 means LaunchServices accepted the request, not that
    // the app came up. The status check is the process table -- matched on
    // the bundle path, which survives process names that differ from app
    // names -- because "Opened X" from a tool should mean X is running, not
    // that a launch was requested.
    for (let i = 0; i < 6; i++) {
      try {
        await run("pgrep", ["-a", "-f", pattern], { timeout: 5_000 });
        return `Opened ${resolved.name}${note} — running.`;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return (
      `Told macOS to open ${resolved.name}, but its process has not appeared yet. ` +
      `It may still be starting.`
    );
  },
};

const proposeTool: BuiltinTool = {
  name: "propose_plan",
  description:
    "Propose something no recipe covers, for the user to approve before it runs. Use when the user asks for an action on their Mac that mac_recipe cannot do. Prefer click/menu/press/type_text steps, copying names exactly from window_controls or menu_items. You are not running this — you are writing down what you would do.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "One plain sentence covering the whole plan. The user reads this first.",
      },
      app: {
        type: "string",
        description: "The app the steps act on, if they all act on the same one.",
      },
      steps: {
        type: "array",
        description:
          "The steps, in order. Give each one exactly one action key. " +
          'Example: [{"summary": "Open Notes", "open": "Notes"}, ' +
          '{"summary": "new note", "menu": "File > New Note"}, ' +
          '{"summary": "type the list", "type_text": "milk, eggs"}]. ' +
          "Copy click/menu names from what window_controls or menu_items printed.",
        items: {
          type: "object",
          properties: {
            summary: { type: "string", description: "What this step does, in a few words." },
            app: { type: "string", description: "Which app, if not the plan's app." },
            open: {
              type: "string",
              description: 'Open an app by name, e.g. "Calendar". Use as the first step when the app may not be running.',
            },
            click: {
              type: "string",
              description: 'A control in the front window, named exactly, e.g. "Save".',
            },
            menu: {
              type: "string",
              description: 'A menu command as printed by menu_items, e.g. "File > Save".',
            },
            type_text: { type: "string", description: "Text to type into the app." },
            press: {
              type: "string",
              description: `One key: ${Object.keys(KEY_CODES).join(", ")}.`,
            },
            script: {
              type: "string",
              description: "AppleScript, for driving a Mac app when no named action fits.",
            },
            shell: {
              type: "string",
              description: "A shell command. Prefer this over AppleScript for files, git, network and anything with a CLI.",
            },
            python: {
              type: "string",
              description: "A Python script. Prefer this for real work — parsing, APIs, files — it is far more reliable than AppleScript.",
            },
          },
          required: ["summary"],
        },
      },
    },
    required: ["summary", "steps"],
  },
  async run(args) {
    const summary = String(args.summary ?? "").trim();

    // A single script is accepted as a one-step plan. The model will sometimes
    // reach for the simpler shape whatever the schema says, and rejecting that
    // wastes a turn over a formatting preference.
    const raw = Array.isArray(args.steps)
      ? (args.steps as Array<Record<string, unknown>>)
      : args.script
        ? [{ summary, script: args.script }]
        : [];

    // Fetched once, and only when something actually needs it -- a plan of
    // plain scripts should not pay for a process spawn.
    const wantsApp = raw.some((s) => STEP_ACTIONS.some(([key]) => s?.[key]));
    let running: string[] = [];
    if (wantsApp) {
      try {
        running = await runningApps();
      } catch (err) {
        const message = osascriptFailure(err);
        return permissionHint(message) ?? `Could not list running apps: ${message}`;
      }
    }

    const steps: Array<{ summary: string; script: string; kind?: PlanKind }> = [];
    // Carried forward so an app named once covers the steps that follow, which
    // is how the model writes them when every step is in the same window.
    let lastApp = String(args.app ?? "");
    // Apps this plan opens. A later step targeting one is accepted even though
    // it is not in the process list yet -- by the time that step runs, the
    // open step before it will have started the app.
    const opened: string[] = [];
    const openedAs = new Map<string, string>();

    for (const s of raw) {
      const stepSummary = String(s?.summary ?? "").trim();
      const action = STEP_ACTIONS.find(([key]) => typeof s?.[key] === "string" && s[key]);

      if (action) {
        const [key, kind] = action;
        let appName: string;
        let renamed = "";

        if (kind === "open") {
          // Opening is the one action whose app need not be running. The
          // name is resolved against what is installed, as open_app does:
          // taken as written, "the browser" reached `open -a` as those
          // two words, and a plan the user approved failed at its first
          // step on a name the tool beside it would have understood.
          const target = await resolveOpenTarget(String(s[key]).trim() || String(s.app ?? lastApp).trim());
          if (!target.ok) return `Cannot propose "${stepSummary}": ${target.reason}`;
          appName = target.name;
          opened.push(appName);
          // What the model wrote may be the short name; later steps that
          // say it again mean this app.
          const written = String(s[key]).trim();
          if (written && written.toLowerCase() !== appName.toLowerCase()) openedAs.set(written.toLowerCase(), appName);
          // Another app than the one written (the person's browser, not
          // the model's pick): the step says which, in the harness's
          // words, and a script elsewhere in the plan that still drives
          // the one the model wrote would open both. Sent back to be
          // written for the app that will open.
          if (target.note) {
            const others = raw.filter((o) => o !== s).map((o) => [o?.script, o?.shell, o?.python].filter((v) => typeof v === "string").join("\n")).join("\n");
            if (written && new RegExp(`\\b${written.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(others) && !new RegExp(appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(written)) {
              return `Cannot propose "${stepSummary}": this would open ${appName}${target.note}, and another step is written for ${written}. Write every step for ${appName}.`;
            }
            renamed = `Open ${appName}${target.note}`;
          }
        } else {
          const wanted = String(s.app ?? lastApp);
          const resolved = resolveApp(wanted, running);
          const openedMatch =
            openedAs.get(wanted.trim().toLowerCase()) ?? opened.find((o) => o.toLowerCase() === wanted.trim().toLowerCase());
          // Refused whole rather than stored with a broken step: a plan the
          // user is asked to approve should never contain one that cannot
          // work.
          if (!resolved.ok && !openedMatch) {
            return `Cannot propose "${stepSummary}": ${resolved.reason}`;
          }
          // The app this plan opens, before one that merely shares the
          // written name and happens to be running.
          appName = openedAs.get(wanted.trim().toLowerCase()) ?? (resolved.ok ? resolved.name : openedMatch!);
        }
        lastApp = appName;

        const compiled = compileAction(kind, appName, kind === "open" ? appName : String(s[key]));
        if (!compiled.ok) return `Cannot propose "${stepSummary}": ${compiled.reason}`;
        steps.push({
          summary: renamed || stepSummary || `${key} ${String(s[key])}`,
          script: compiled.script,
        });
        continue;
      }

      // A script step, in whichever language it was written. AppleScript keeps
      // the double-unescaping repair because that failure is specific to it:
      // the model escapes its quotes twice and osascript dies on character 17.
      // Shell and Python are taken verbatim -- a backslash in them is far more
      // likely to be deliberate than a mangled quote.
      const written: Array<[key: string, kind: PlanKind]> = [
        ["script", "applescript"],
        ["shell", "shell"],
        ["python", "python"],
      ];
      const found = written.find(([key]) => typeof s?.[key] === "string" && String(s[key]).trim());
      if (found) {
        const [key, kind] = found;
        const raw = String(s[key]).trim();
        steps.push({
          summary: stepSummary,
          script: kind === "applescript" ? unescapeQuotes(raw) : raw,
          kind,
        });
        continue;
      }

      // A step with neither an action nor a script is refused by name, with a
      // worked example. The first version of this message listed the key
      // names -- "give each step one of: open, click, ..." -- and the model
      // re-sent the same summary-only steps three times in a row: it did not
      // connect the words in the list to JSON keys on the step object. An
      // example is the connection. Dropping the step silently was worse
      // still; see the version before that.
      return (
        `Cannot propose "${stepSummary || "(unnamed step)"}": the step describes an action ` +
        `but does not carry one. Each step needs an action key. Like this:\n` +
        `{"summary": "Open Notes", "open": "Notes"}\n` +
        `{"summary": "new note", "menu": "File > New Note", "app": "Notes"}\n` +
        `{"summary": "type the items", "type_text": "milk, eggs"}\n` +
        `Actions: ${STEP_ACTIONS.map(([k]) => k).join(", ")}. Or a script: shell, python, script.`
      );
    }

    if (!summary || steps.length === 0) {
      return "Error: a plan needs a summary and at least one step with a script.";
    }

    const plan = proposePlan({
      sessionId: currentSessionId || null,
      summary,
      kind: "applescript",
      steps,
      request: turnMessageSaid(),
    });

    // The widget is what the user acts on; the text is what the model reads,
    // and it says the work is not done so the model does not report success.
    // The turn ends here, on the harness's account of the plan (`final`):
    // told to "reply in a sentence and stop", the model sometimes called
    // another tool instead, and sometimes reported the plan as done.
    return {
      text:
        `Proposed, not run. The user has been shown this plan and must approve it:\n\n` +
        steps.map((s, i) => `${i + 1}. ${s.summary}`).join("\n") +
        `\n\nDo not try to run it yourself and do not call another tool.`,
      widget: { type: "plan", id: plan.id, summary, steps, request: plan.request },
      final: planReply(summary, steps),
    };
  },
};

/** A function, not a const: desktop control can now be enabled at runtime
 *  (the launcher button), and the registry rebuild that follows must see the
 *  gate's current answer -- a const spread the import-time answer forever. */
export function buildDesktopTools(): BuiltinTool[] {
  return [
    // open_app sits with the recipes, not behind the flag: the gate is about
    // irreversibility, and opening an app is undone by quitting it.
    ...(recipesEnabled() ? [recipeTool, openAppTool] : []),
    ...(desktopEnabled() ? [screenshotTool, appleScriptTool, proposeTool] : []),
  ];
}
