import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Which browser is "the browser".
 *
 * Asked "check my email on browser", the operator opened Safari on a
 * machine whose default browser is Chrome: the model picked the browser it
 * has read about most. Which browser a person means is not a judgement. It
 * is the one they named, else one they already have open, else the one the
 * system opens links in, and each of those is a fact the harness can look
 * up. So the model's pick stands only when the person's own words leave
 * room for it: when they said "browser", or named a different one, the
 * answer comes from here.
 *
 * The list is what makes a name a browser: for telling which running apps
 * are browsers, and which word in a message names one. The DEFAULT does
 * not come from the list. It is asked of the system, so a browser nobody
 * listed here is still found when it is the one links open in.
 */
/**
 * `said` is how a message names the browser. Six of these names are also
 * ordinary words, and read bare they named a browser nobody meant: "be
 * brave and open my inbox" opened Brave, "the left edge of the screen"
 * opened Edge. Those count only where a browser is being spoken of:
 * after a word that takes an app (in, on, with, using, via, open, launch,
 * try, use), before "browser", or by the full product name.
 */
const inContext = (word: string, full: string): RegExp =>
  new RegExp(`\\b(?:in|on|with|using|via|open|launch|start|try|use)\\s+(?:the\\s+)?${word}\\b|\\b${word}\\s+browser\\b|\\b${full}\\b`, "i");

export const BROWSERS: ReadonlyArray<{ name: string; said: RegExp }> = [
  { name: "Safari", said: /\bsafari\b/i },
  { name: "Google Chrome", said: /\b(?:google )?chrome\b/i },
  { name: "Firefox", said: /\bfirefox\b/i },
  { name: "Arc", said: inContext("arc", "arc browser") },
  { name: "Brave Browser", said: inContext("brave", "brave browser") },
  { name: "Microsoft Edge", said: inContext("edge", "microsoft edge") },
  { name: "Opera", said: inContext("opera", "opera browser") },
  { name: "Vivaldi", said: /\bvivaldi\b/i },
  { name: "Chromium", said: /\bchromium\b/i },
  { name: "DuckDuckGo", said: /\bduckduckgo\b/i },
  { name: "Orion", said: inContext("orion", "orion browser") },
  { name: "Zen", said: inContext("zen", "zen browser") },
];

/** A word for a browser that names none: "browser", "my browser", "the web browser". */
const GENERIC = /^(?:(?:the|my|a|your|default|web|internet)\s+)*browser$/i;

export const isBrowser = (app: string): boolean => BROWSERS.some((b) => b.name.toLowerCase() === app.trim().toLowerCase());
/** Whether an app argument asks for a browser without saying which. */
export const anyBrowser = (app: string): boolean => GENERIC.test(app.trim());
/** The person saying "browser" in their own message. */
export const saysBrowser = (text: string): boolean => /\bbrowser\b/i.test(text);
/** The browsers a text names, in the list's order. Not "chrome" inside
 *  "Chrome Remote Desktop": that is another program's name. */
export function browsersNamed(text: string): string[] {
  const plain = text.replace(/\bchrome remote desktop\b/gi, " ");
  return BROWSERS.filter((b) => b.said.test(plain)).map((b) => b.name);
}

/**
 * The app the system opens a web link in, by the name `open -a` takes.
 *
 * Asked through NSWorkspace, which is where the answer lives: the
 * LaunchServices preference file records only a choice that differs from
 * the built-in one, and in more than one shape. No Apple Event is sent, so
 * this needs no Automation permission and touches no app. Null when it
 * cannot be asked (not macOS, or the bridge is missing): the caller then
 * has no default and says so.
 */
export async function defaultBrowser(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await run(
      "osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com")).path.js',
      ],
      { timeout: 10_000 },
    );
    const path = stdout.trim();
    return path.endsWith(".app") ? basename(path, ".app") : null;
  } catch {
    return null;
  }
}

export interface BrowserChoice {
  /** The browser to use, or null with a question to ask instead. */
  name: string | null;
  /** Why this one, for the tool result: the person reads it, and it is the
   *  only place the model learns its own pick was not taken. */
  why: string;
}

/**
 * The person's browser, given what they said and what the machine shows.
 *
 * `asked` is what the model wanted opened: a browser's name, or a generic
 * word. `message` is the person's own message this turn, null when there
 * is none to read (an automation step, a tool run outside a turn): then
 * the model's pick is all there is and it stands.
 */
export function chooseBrowser(input: {
  asked: string;
  message: string | null;
  running: string[];
  installed: string[];
  dflt: string | null;
}): BrowserChoice {
  const has = (name: string) => input.installed.some((a) => a.toLowerCase() === name.toLowerCase());
  const generic = anyBrowser(input.asked);
  const named = input.message === null ? [] : browsersNamed(input.message).filter(has);

  // Named by the person: theirs, whatever the model asked for.
  if (named.length === 1) {
    const same = named[0]!.toLowerCase() === input.asked.trim().toLowerCase();
    return { name: named[0]!, why: same ? "" : "the browser you named" };
  }
  if (named.length > 1) {
    const pick = named.find((n) => n.toLowerCase() === input.asked.trim().toLowerCase());
    if (pick) return { name: pick, why: "" };
    return { name: null, why: `You named ${named.join(" and ")}. Which one?` };
  }
  // The model named one and the person's words do not speak of a browser
  // at all: nothing here contradicts it.
  if (!generic && (input.message === null || !saysBrowser(input.message))) {
    return { name: input.asked.trim(), why: "" };
  }
  // "The browser": one that is already open, else the system's.
  const same = (a: string, b: string | null) => b !== null && a.toLowerCase() === b.toLowerCase();
  const open = input.running.filter((a) => isBrowser(a) || same(a, input.dflt));
  if (open.length === 1) return { name: open[0]!, why: "the browser you have open" };
  if (input.dflt && (open.length === 0 || open.some((a) => same(a, input.dflt)))) {
    return { name: input.dflt, why: open.length > 1 ? "your default browser, which is open" : "your default browser" };
  }
  if (open.length > 1) return { name: null, why: `${open.join(" and ")} are both open. Which one?` };
  return { name: null, why: "I could not tell which browser is yours. Which one should I use?" };
}
