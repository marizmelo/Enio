import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { config } from "../config.js";
import { detectPlatform } from "../platform.js";
import { readImage } from "../vision.js";
import type { ToolDef } from "../types.js";
import { listSavedRecipes, osascriptFailure, proposePlan, runScript, type PlanKind } from "../plans.js";
import { autoRunEnabled, desktopControlStored } from "../automation.js";
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
  /** Needs an app; the *resolved* name is interpolated, never the raw input. */
  needsApp?: true;
  /** Reads the accessibility tree, so it is withheld until macOS allows that. */
  needsAx?: true;
  /** Preferred over the AppleScript when the direct bridge is available: it
   *  reaches apps System Events cannot see at all. */
  direct?: (ctx: { count: number; app: string }) => Promise<string | null>;
}

const RECIPES: Record<string, Recipe> = {
  recent_emails: {
    summary: "Subject and sender of the most recent inbox messages",
    script: ({ count }) =>
      `tell application "Mail" to get {subject, sender} of messages 1 thru ${count} of inbox`,
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

const recipeTool: ToolDef = {
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

      const plan = proposePlan({
        sessionId: currentSessionId || null,
        summary: saved.summary || `Run the ${name} recipe`,
        kind: saved.kind,
        steps: [{ summary: saved.summary || name, script: saved.script, kind: saved.kind }],
      });
      return {
        text:
          `"${name}" is saved but not marked safe to run on its own` +
          `${autoRunEnabled() ? "" : ", and automatic running is off"}, so it is ` +
          `waiting for the user to approve it. Tell them briefly and call nothing else.`,
        widget: {
          type: "plan",
          id: plan.id,
          summary: saved.summary || `Run the ${name} recipe`,
          steps: [{ summary: saved.summary || name, script: saved.script, kind: saved.kind }],
        },
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
      return capped((stdout || stderr).trim()) || "(nothing to report)";
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

const openAppTool: ToolDef = {
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
    const apps = await installedApps();
    const resolved = resolveApp(String(args.app ?? ""), apps, "installed");
    if (!resolved.ok) return resolved.reason;
    try {
      await run("open", ["-a", resolved.name], { timeout: 15_000 });
    } catch (err) {
      return `Could not open ${resolved.name}: ${(err as Error & { stderr?: string }).stderr?.trim() || (err as Error).message}`;
    }

    // `open` exiting 0 means LaunchServices accepted the request, not that
    // the app came up. The status check is the process table -- matched on
    // the bundle path, which survives process names that differ from app
    // names -- because "Opened X" from a tool should mean X is running, not
    // that a launch was requested.
    const pattern = `/${resolved.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.app/`;
    for (let i = 0; i < 6; i++) {
      try {
        await run("pgrep", ["-f", pattern], { timeout: 5_000 });
        return `Opened ${resolved.name} — running.`;
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

const proposeTool: ToolDef = {
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

    for (const s of raw) {
      const stepSummary = String(s?.summary ?? "").trim();
      const action = STEP_ACTIONS.find(([key]) => typeof s?.[key] === "string" && s[key]);

      if (action) {
        const [key, kind] = action;
        let appName: string;

        if (kind === "open") {
          // Opening is the one action whose app need not be running; the name
          // is taken as written, and the compiled script is what the user
          // approves.
          appName = String(s[key]).trim() || String(s.app ?? lastApp).trim();
          if (appName) opened.push(appName);
        } else {
          const wanted = String(s.app ?? lastApp);
          const resolved = resolveApp(wanted, running);
          const openedMatch = opened.find((o) => o.toLowerCase() === wanted.trim().toLowerCase());
          // Refused whole rather than stored with a broken step: a plan the
          // user is asked to approve should never contain one that cannot
          // work.
          if (!resolved.ok && !openedMatch) {
            return `Cannot propose "${stepSummary}": ${resolved.reason}`;
          }
          appName = resolved.ok ? resolved.name : openedMatch!;
        }
        lastApp = appName;

        const compiled = compileAction(kind, appName, String(s[key]));
        if (!compiled.ok) return `Cannot propose "${stepSummary}": ${compiled.reason}`;
        steps.push({
          summary: stepSummary || `${key} ${String(s[key])}`,
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
    });

    // The widget is what the user acts on; the text is what the model reads,
    // and it says the work is not done so the model does not report success.
    return {
      text:
        `Proposed, not run. The user has been shown this plan and must approve it:\n\n` +
        steps.map((s, i) => `${i + 1}. ${s.summary}`).join("\n") +
        `\n\nTell them briefly what you are proposing and that it is waiting for them. ` +
        `Do not try to run it yourself and do not call another tool.`,
      widget: { type: "plan", id: plan.id, summary, steps },
    };
  },
};

/** A function, not a const: desktop control can now be enabled at runtime
 *  (the launcher button), and the registry rebuild that follows must see the
 *  gate's current answer -- a const spread the import-time answer forever. */
export function buildDesktopTools(): ToolDef[] {
  return [
    // open_app sits with the recipes, not behind the flag: the gate is about
    // irreversibility, and opening an app is undone by quitting it.
    ...(recipesEnabled() ? [recipeTool, openAppTool] : []),
    ...(desktopEnabled() ? [screenshotTool, appleScriptTool, proposeTool] : []),
  ];
}
