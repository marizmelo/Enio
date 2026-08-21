import { scriptAccountWith } from "../accounts.js";
import { callScript } from "../appsscript.js";
import type { ToolDef } from "../types.js";

/**
 * The connected account's life beyond mail: calendar, todos, contacts.
 *
 * These belong to the planner specialist, not to mail — the mail agent had
 * only two free slots and calendar-plus-todos-plus-contacts needs four, and
 * "what's on today" is not a mail question however the plumbing overlaps.
 *
 * Same rules as the mail wiring, because they are the same rules everywhere:
 * the credential is attached here, harness-side, and the model sees results
 * only; reading is offered with any connected account, while the tools that
 * CHANGE the account's state exist only when their grant was ticked —
 * withheld, not offered-and-refused.
 */

const readCalendarTool: ToolDef = {
  name: "read_calendar",
  description:
    "Upcoming events from the connected calendar: title, time, location, and the Meet link when there is one.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      days: { type: "number", description: "How many days ahead to look. Default 7." },
    },
    required: [],
  },
  async run(args) {
    const account = scriptAccountWith("calendar.read");
    if (!account) return "No connected account can read a calendar.";
    const result = await callScript(account.url, account.secret, "calendar.upcoming", {
      days: Math.min(60, Math.max(1, Number(args.days ?? 7) || 7)),
    });
    if (!result.ok) return `Could not read the calendar: ${result.error}`;
    const events = (result.result as Array<Record<string, string>>) ?? [];
    if (events.length === 0) return `Nothing on the calendar for ${account.email} in that window.`;
    const lines = events.map((e) => {
      const start = String(e.start ?? "").slice(0, 16).replace("T", " ");
      const end = String(e.end ?? "").slice(11, 16);
      return `${start}–${end}  ${e.title || "(untitled)"}${e.location ? ` — ${e.location}` : ""}`;
    });
    return `${events.length} event(s) for ${account.email}:\n${lines.join("\n")}`;
  },
};

const addEventTool: ToolDef = {
  name: "add_event",
  description:
    "Add an event to the connected calendar. Confirm the details with the user before calling this. Set meet true to attach a Google Meet link.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "What the event is." },
      start: { type: "string", description: "Start time, like 2026-08-22 14:00 (24h)." },
      end: { type: "string", description: "End time, same format." },
      location: { type: "string", description: "Optional." },
      description: { type: "string", description: "Optional." },
      meet: { type: "boolean", description: "Optional. true attaches a Google Meet link." },
    },
    required: ["title", "start", "end"],
  },
  async run(args) {
    const account = scriptAccountWith("calendar.write");
    if (!account) return "The connected account was not granted calendar changes.";
    const result = await callScript(account.url, account.secret, "calendar.add", {
      title: String(args.title ?? ""),
      start: String(args.start ?? ""),
      end: String(args.end ?? ""),
      location: args.location ? String(args.location) : "",
      description: args.description ? String(args.description) : "",
      meet: args.meet === true,
    });
    if (!result.ok) return `Could not add the event: ${result.error}`;
    const made = result.result as Record<string, string>;
    return `Added "${made.title}" to ${account.email}${made.meet ? ` — Meet link: ${made.meet}` : ""}.`;
  },
};

const listTodosTool: ToolDef = {
  name: "list_todos",
  description: "The connected account's open todos (Google Tasks), grouped by list.",
  origin: "builtin",
  parameters: { type: "object", properties: {}, required: [] },
  async run() {
    const account = scriptAccountWith(null);
    if (!account) return "No account is connected.";
    const result = await callScript(account.url, account.secret, "tasks.list", {});
    if (!result.ok) return `Could not read todos: ${result.error}`;
    const lists = (result.result as Array<{ list: string; tasks: Array<Record<string, string>> }>) ?? [];
    const total = lists.reduce((n, l) => n + l.tasks.length, 0);
    if (total === 0) return `No open todos for ${account.email}.`;
    return lists
      .filter((l) => l.tasks.length > 0)
      .map(
        (l) =>
          `${l.list}:\n` +
          l.tasks.map((t) => `  • ${t.title}${t.due ? ` (due ${String(t.due).slice(0, 10)})` : ""}`).join("\n"),
      )
      .join("\n\n");
  },
};

const addTodoTool: ToolDef = {
  name: "add_todo",
  description: "Add a todo (Google Task) to the connected account.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "The todo, as one line." },
      due: { type: "string", description: "Optional due date, like 2026-08-25." },
      notes: { type: "string", description: "Optional details." },
    },
    required: ["title"],
  },
  async run(args) {
    // calendar.write is the "may change your day" grant: todos have no scope
    // of their own in the grant list, and an account connected read-only must
    // not gain a write path through the side door.
    const account = scriptAccountWith("calendar.write");
    if (!account) return "The connected account was not granted changes.";
    const result = await callScript(account.url, account.secret, "tasks.add", {
      title: String(args.title ?? ""),
      due: args.due ? new Date(String(args.due)).toISOString() : undefined,
      notes: args.notes ? String(args.notes) : "",
    });
    if (!result.ok) return `Could not add the todo: ${result.error}`;
    return `Added "${(result.result as Record<string, string>).title}" to ${account.email}'s todos.`;
  },
};

const findContactTool: ToolDef = {
  name: "find_contact",
  description:
    "Look up a person in the connected account's contacts: name, email addresses, phone numbers.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "A name, or part of one." },
    },
    required: ["query"],
  },
  async run(args) {
    const account = scriptAccountWith(null);
    if (!account) return "No account is connected.";
    const result = await callScript(account.url, account.secret, "contacts.find", {
      query: String(args.query ?? ""),
    });
    if (!result.ok) return `Could not search contacts: ${result.error}`;
    const people = (result.result as Array<{ name: string; emails: string[]; phones: string[] }>) ?? [];
    if (people.length === 0) return `Nobody matching "${args.query}" in ${account.email}'s contacts.`;
    return people
      .map((p) => `${p.name || "(no name)"}  ${p.emails.join(", ")}${p.phones.length ? `  ${p.phones.join(", ")}` : ""}`)
      .join("\n");
  },
};

const searchDriveTool: ToolDef = {
  name: "search_drive",
  description:
    "Find files in the connected Google Drive by name: Docs, Slides, Sheets and uploads. Returns ids for read_drive.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Part of the file's name." },
    },
    required: ["query"],
  },
  async run(args) {
    const account = scriptAccountWith("drive.read");
    if (!account) return "The connected account was not granted Drive reading.";
    const result = await callScript(account.url, account.secret, "drive.find", {
      query: String(args.query ?? ""),
    });
    if (!result.ok) return `Could not search Drive: ${result.error}`;
    const files = (result.result as Array<Record<string, string>>) ?? [];
    if (files.length === 0) return `Nothing named like "${args.query}" in ${account.email}'s Drive.`;
    return (
      files.map((f) => `[${f.id}] ${f.name}  (${shortType(f.type)})`).join("\n") +
      "\n\nRead one with read_drive using its [id]."
    );
  },
};

const readDriveTool: ToolDef = {
  name: "read_drive",
  description:
    "Read a Drive file as text by the id from search_drive. Docs, Slides and Sheets are exported as text automatically.",
  origin: "builtin",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The [id] shown by search_drive." },
    },
    required: ["id"],
  },
  async run(args) {
    const account = scriptAccountWith("drive.read");
    if (!account) return "The connected account was not granted Drive reading.";
    const result = await callScript(account.url, account.secret, "drive.read", {
      id: String(args.id ?? ""),
    });
    if (!result.ok) return `Could not read the file: ${result.error}`;
    const file = result.result as Record<string, string>;
    if (!file.text) return `${file.name}: ${file.note ?? "nothing readable inside."}`;
    return `${file.name}\n\n${file.text}`;
  },
};

/** "application/vnd.google-apps.presentation" says nothing a person needs;
 *  the last word does. */
function shortType(mime: string | undefined): string {
  const type = String(mime ?? "");
  if (type.endsWith(".document")) return "Doc";
  if (type.endsWith(".presentation")) return "Slides";
  if (type.endsWith(".spreadsheet")) return "Sheet";
  return type.split("/").pop() ?? "file";
}

/**
 * Reads exist with any connected account; writes only with their grant.
 * Load-time like every other config gate — connecting an account shows the
 * tools on restart. In single-agent mode these count toward the 16-tool
 * registry cap, so they are registered near the mail tools rather than at
 * the tail, where the cap silently eats whatever comes last.
 */
export const googleTools: ToolDef[] = [
  ...(scriptAccountWith("calendar.read") ? [readCalendarTool] : []),
  ...(scriptAccountWith("calendar.write") ? [addEventTool, addTodoTool] : []),
  ...(scriptAccountWith("drive.read") ? [searchDriveTool, readDriveTool] : []),
  ...(scriptAccountWith(null) ? [listTodosTool, findContactTool] : []),
];
