/**
 * What each built-in tool is, said once.
 *
 * The harness asks the same few questions about a tool in many places: did
 * this turn go to the web, may this agent hold it beside a shell, did it
 * leave a file behind, which argument goes on the badge. Each place used to
 * keep its own list of names, and the lists drifted without anything
 * failing: the library tool was spelled two ways, a rendered fetch counted
 * as the web in three lists and not in two, the two calendar writes and the
 * automation runner were on neither copy of the list that keeps a web
 * reader away from them. A list entry that is missing is not an error, it
 * is an answer -- "no" -- so nothing could notice.
 *
 * So the facts live here and the lists are derived. BuiltinTool (types.ts)
 * takes its names from this table, which makes a definition with no row a
 * compile error on every machine, including for a tool this machine
 * withholds. Every field is required for the same reason: `acts: false` is
 * a decision somebody made, where an absent key is a thing nobody thought
 * about. What the compiler cannot do is tell whether the decision was
 * right: a new tool typed `acts: false` that in fact writes passes
 * everything. The row is where that is reviewed.
 *
 * A table and not a field on each definition, for three reasons. Restore,
 * the gap ledger and the save check work from stored NAMES -- a past
 * turn's steps, a saved agent's tool list -- with no definition in hand,
 * and must still know what `browse` was on a machine where it is withheld
 * today. Most definitions are private to their module and handed out only
 * through a gate, and two come out of a factory, so a field could be read
 * only off a tool this machine registers. And the read/act column is a
 * security boundary: it should be readable top to bottom in one place.
 *
 * No trait is sent to the model. toWireTool copies name, description and
 * parameters and nothing else, and the descriptions and prompts stay
 * hand-written: they are measured wording, not facts to generate. A trait
 * can still decide which held tool NAMES a harness correction lists.
 *
 * A leaf: it imports nothing, so anything may import it.
 */

/**
 * Where the substance of a tool's result comes from.
 *
 *   web     pages on the open internet, written by strangers. The untrusted
 *           half of the read/act boundary.
 *   files   the user's own stored material: the working folders, the
 *           library, a mailbox, Drive.
 *   live    a current reading of the world that is not a page the model
 *           reads: the clock, a forecast.
 *   memory  Enio's own store.
 *   null    no label claims the result. Either it is an acknowledgement
 *           or know-how, or it is a reading this column has no word for
 *           yet: a command's output, an app, the screen, the connected
 *           calendar. Those were in no list before and are left as found.
 */
export type Reads = "web" | "files" | "live" | "memory";

/** The kind of thing a successful call leaves behind: the artifact kinds of
 *  artifacts.ts, which is where the output line that names it is parsed. */
export type Makes = "document" | "image" | "email_draft" | "plan";

export interface ToolTraits {
  readonly reads: Reads | null;
  /** A call can change something outside the reply: a file, the machine, a
   *  mailbox, a calendar, memory. The acting half of the read/act boundary. */
  readonly acts: boolean;
  readonly makes: Makes | null;
  /** The argument that IS the call, in order of preference: what a badge
   *  shows. Empty means no single argument is, and the badge lists the short
   *  ones. Never an argument that carries a whole document. */
  readonly headline: readonly string[];
}

const TRAITS = {
  // ── Know-how, clock, forecast ────────────────────────────────────────────
  read_skill: { reads: null, acts: false, makes: null, headline: ["name"] },
  current_time: { reads: "live", acts: false, makes: null, headline: [] },
  weather: { reads: "live", acts: false, makes: null, headline: [] },

  // ── Memory ───────────────────────────────────────────────────────────────
  remember: { reads: null, acts: true, makes: null, headline: ["fact"] },
  set_preference: { reads: null, acts: true, makes: null, headline: [] },
  recall: { reads: "memory", acts: false, makes: null, headline: ["query"] },

  // ── Files ────────────────────────────────────────────────────────────────
  read_file: { reads: "files", acts: false, makes: null, headline: ["path"] },
  write_file: { reads: null, acts: true, makes: "document", headline: ["path"] },
  // An edit lands only where its old text matches the file as it stands, so
  // a successful one is also an account of what the file held. Kept as a
  // read for that reason, and because a turn whose only call was an edit
  // has always been labelled "from files".
  edit_file: { reads: "files", acts: true, makes: "document", headline: ["path"] },
  list_dir: { reads: "files", acts: false, makes: null, headline: ["path"] },
  search_code: { reads: "files", acts: false, makes: null, headline: ["query"] },
  find_file: { reads: "files", acts: false, makes: null, headline: ["query"] },
  library_search: { reads: "files", acts: false, makes: null, headline: ["query"] },
  read_image: { reads: "files", acts: false, makes: null, headline: ["path"] },
  run_command: { reads: null, acts: true, makes: null, headline: ["command"] },

  // ── Mail and Drive ───────────────────────────────────────────────────────
  // The user's own material for the label, as the mailbox always was. A
  // message or a shared file is also text a stranger wrote, and the
  // read/act boundary (`reads: "web"`) does not count it: the mail agent
  // reads mail and holds send_email. Left as found (DECISIONS.md).
  search_email: { reads: "files", acts: false, makes: null, headline: ["query"] },
  read_email: { reads: "files", acts: false, makes: null, headline: ["id"] },
  // Acting, though it sends nothing: it writes a message into the outbox
  // and a file on disk, and puts a card in front of the person that one
  // click sends. A web reader holding it could be made to write to anyone.
  send_email: { reads: null, acts: true, makes: "email_draft", headline: [] },
  search_drive: { reads: "files", acts: false, makes: null, headline: [] },
  read_drive: { reads: "files", acts: false, makes: null, headline: [] },

  // ── Calendar, tasks, contacts ────────────────────────────────────────────
  // These three read the connected account, and `reads` has no word for
  // that yet: an answer built on them is still labelled as coming from the
  // model. Left as it was found rather than settled in passing -- what such
  // an answer should be called is a product decision (DECISIONS.md).
  read_calendar: { reads: null, acts: false, makes: null, headline: [] },
  list_todos: { reads: null, acts: false, makes: null, headline: [] },
  find_contact: { reads: null, acts: false, makes: null, headline: [] },
  // Acting is not only the machine. A page that can get an event or a task
  // added has written to the user's calendar account, and nothing on this
  // side of the script asks first.
  add_event: { reads: null, acts: true, makes: null, headline: [] },
  add_todo: { reads: null, acts: true, makes: null, headline: [] },

  // ── The machine ──────────────────────────────────────────────────────────
  // Its result is also a reading of whatever is on screen. Not marked as
  // one: no list counted it as a read before, and `live` here would have
  // the operator told to take a screenshot when it disclaims live access.
  take_screenshot: { reads: null, acts: true, makes: "image", headline: [] },
  run_applescript: { reads: null, acts: true, makes: null, headline: [] },
  // The built-in recipes are reads from a closed list, but the same tool
  // runs saved ones by name: a script a person approved, which runs unasked
  // when it is marked safe and auto-run is on.
  mac_recipe: { reads: null, acts: true, makes: null, headline: [] },
  open_app: { reads: null, acts: true, makes: null, headline: [] },
  propose_plan: { reads: null, acts: true, makes: "plan", headline: [] },
  // It takes a name and nothing else, so a page cannot put its own words
  // into an automation -- but it can start one, and a saved automation
  // writes files and drafts mail under its own agents with no approval.
  run_pipeline: { reads: null, acts: true, makes: null, headline: ["name"] },

  // ── The web ──────────────────────────────────────────────────────────────
  web_search: { reads: "web", acts: false, makes: null, headline: ["query"] },
  web_fetch: { reads: "web", acts: false, makes: null, headline: ["url"] },
  web_fetch_rendered: { reads: "web", acts: false, makes: null, headline: ["url"] },
  // Not acting, on purpose, though with ENIO_BROWSER_ACT=1 it clicks and
  // types. A fixed column cannot say "acts when a setting is on", and
  // marking it would fail the researcher against its own boundary. The
  // flag is the user's explicit trade and the blast radius stays the
  // browser session: no shell, no filesystem, no mail (web.test.ts). With
  // the flag off it still navigates, inside a session that may hold saved
  // logins, so a followed link is a request made as the user.
  browse: { reads: "web", acts: false, makes: null, headline: ["url"] },
} as const satisfies Record<string, ToolTraits>;

/** Every built-in tool's name, registered on this machine or not. */
export type BuiltinToolName = keyof typeof TRAITS;

export const BUILTIN_TRAITS: Readonly<Record<BuiltinToolName, ToolTraits>> = TRAITS;

export const BUILTIN_TOOL_NAMES = Object.keys(TRAITS) as BuiltinToolName[];

// The acting column is a security boundary, and the sets read from it are
// computed once at load. Frozen so that nothing can flip a row afterwards
// and leave the two disagreeing.
for (const name of BUILTIN_TOOL_NAMES) {
  Object.freeze(TRAITS[name].headline);
  Object.freeze(TRAITS[name]);
}
Object.freeze(TRAITS);

/**
 * A tool's traits, or null for a name this table does not hold.
 *
 * Null is every MCP tool, and it reads as "nothing": not a web reader, not
 * acting, makes nothing, no headline. That is what the hand lists said
 * before, since none of them ever named one, and it is a known hole rather
 * than a judgement: a custom agent may hold a web tool beside an MCP tool
 * that writes files. The other default -- an unclassified tool both reads
 * strangers' text and acts -- refuses agents that save today, so it was
 * left for a decision of its own (DECISIONS.md).
 */
export function traitsOf(name: string): ToolTraits | null {
  return Object.hasOwn(TRAITS, name) ? TRAITS[name as BuiltinToolName] : null;
}

/** The names a test of the traits holds for, as a set to ask by name. */
export function toolsWhere(test: (traits: ToolTraits) => boolean): Set<string> {
  return new Set(BUILTIN_TOOL_NAMES.filter((name) => test(TRAITS[name])));
}

/** Whether a tool's result comes from one of the given places. */
export function toolReads(name: string, ...from: Reads[]): boolean {
  const reads = traitsOf(name)?.reads ?? null;
  return reads !== null && from.includes(reads);
}

export function toolActs(name: string): boolean {
  return traitsOf(name)?.acts ?? false;
}

export function toolMakes(name: string): Makes | null {
  return traitsOf(name)?.makes ?? null;
}
