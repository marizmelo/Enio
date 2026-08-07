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
    const script = String(args.script ?? "").trim();
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

export const desktopTools: ToolDef[] = desktopEnabled()
  ? [screenshotTool, appleScriptTool]
  : [];
