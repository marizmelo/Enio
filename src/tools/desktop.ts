import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { config } from "../config.js";
import { detectPlatform } from "../platform.js";
import { readImage } from "../vision.js";
import type { ToolDef } from "../types.js";

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

export const desktopEnabled = () =>
  config.desktopEnabled && detectPlatform().startsWith("macos");

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

const screenshotTool: ToolDef = {
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
    const file = join(config.workspace, `screen-${Date.now()}.png`);
    try {
      // -x suppresses the shutter sound; -o omits window shadows so the crop
      // is tight. Screen Recording permission is required and macOS prompts
      // for it the first time.
      const flags = args.window ? ["-x", "-o", "-w"] : ["-x"];
      await run("screencapture", [...flags, file], { timeout: 15_000 });
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
    return `Screenshot saved to ${file}\n\n${reading.text}`;
  },
};

const appleScriptTool: ToolDef = {
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
      const message = (err as Error & { stderr?: string }).stderr ?? (err as Error).message;
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
const RECIPES: Record<string, { summary: string; script: (n: number) => string }> = {
  recent_emails: {
    summary: "Subject and sender of the most recent inbox messages",
    script: (n) =>
      `tell application "Mail" to get {subject, sender} of messages 1 thru ${n} of inbox`,
  },
  unread_count: {
    summary: "How many unread messages are in the inbox",
    script: () => `tell application "Mail" to get unread count of inbox`,
  },
  latest_email_body: {
    summary: "Full text of the single most recent message",
    script: () => `tell application "Mail" to get content of message 1 of inbox`,
  },
  todays_events: {
    summary: "Calendar events starting today",
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
    script: (n) => `tell application "Notes" to get name of notes 1 thru ${n}`,
  },
  desktop_files: {
    summary: "Files on the Desktop",
    script: () => `tell application "Finder" to get name of items of desktop`,
  },
};

const recipeTool: ToolDef = {
  name: "mac_recipe",
  description:
    "Read something from a Mac app using a tested script. Use this rather than writing AppleScript. Recipes: " +
    Object.entries(RECIPES)
      .map(([name, r]) => `${name} (${r.summary})`)
      .join("; "),
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      recipe: {
        type: "string",
        enum: Object.keys(RECIPES),
        description: "Which recipe to run.",
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
    const recipe = RECIPES[name];
    if (!recipe) {
      return `No recipe named "${name}". Available: ${Object.keys(RECIPES).join(", ")}`;
    }

    // Clamped and integer-only: this is the only part of the script the model
    // influences, and it should not be able to make it something else.
    const raw = Number(args.count ?? 5);
    const count = Number.isFinite(raw) ? Math.min(50, Math.max(1, Math.floor(raw))) : 5;

    try {
      const { stdout, stderr } = await run("osascript", ["-e", recipe.script(count)], {
        timeout: config.shellTimeoutMs,
        maxBuffer: 4_000_000,
      });
      return (stdout || stderr).trim() || "(nothing to report)";
    } catch (err) {
      const message = (err as Error & { stderr?: string }).stderr ?? (err as Error).message;
      if (/not authori[sz]ed|1743|-1743/.test(message)) {
        return (
          `macOS blocked this.\n${message}\n\n` +
          `Grant access in System Settings → Privacy & Security → Automation.`
        );
      }
      return `Could not read that: ${message}`;
    }
  },
};

export const desktopTools: ToolDef[] = desktopEnabled()
  ? [screenshotTool, appleScriptTool, recipeTool]
  : [];
