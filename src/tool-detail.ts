/**
 * What a tool call actually was, in one line.
 *
 * The thread showed only a tool's NAME, which answers "did it run a command"
 * and not "which command, and did it work" — the question anyone reading a
 * `run_command` badge is asking. This turns a call into something a person can
 * read at a glance.
 *
 * Shared by the live stream and by restore, so a conversation reopened
 * tomorrow says exactly what it said while it ran. Both sides have the same
 * material (the args as JSON, the tool's own output), so the only way they
 * could disagree is by computing it twice.
 */

/** The argument that IS the call, per tool. A closed list: a generic "first
 *  string field" would print a file's whole contents for write_file. */
const HEADLINE: Record<string, string[]> = {
  run_command: ["command"],
  read_file: ["path"],
  write_file: ["path"],
  edit_file: ["path"],
  search_code: ["query"],
  list_dir: ["path"],
  find_file: ["name", "query"],
  web_search: ["query"],
  web_fetch: ["url"],
  web_fetch_rendered: ["url"],
  browse: ["url", "action"],
  read_image: ["path"],
  read_skill: ["name"],
  recall: ["query"],
  remember: ["fact"],
  search_library: ["query"],
  read_email: ["id"],
  search_email: ["query"],
  run_pipeline: ["name"],
};

export function callDetail(name: string, args: Record<string, unknown>): string {
  const keys = HEADLINE[name] ?? [];
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return clip(value.trim());
  }
  // An unlisted tool (every MCP one) still says something rather than nothing:
  // its short string arguments, which is what its parameters usually are.
  const parts = Object.entries(args ?? {})
    .filter(([, v]) => typeof v === "string" && v.length <= 120)
    .map(([k, v]) => `${k}: ${v}`);
  return clip(parts.join(", "));
}

/**
 * Whether the call worked, read from the tool's own output.
 *
 * The output is the only honest source — a tool that refuses returns text, it
 * does not throw — so these prefixes are the ones the tools themselves write.
 * "background" is its own status because a started server is neither finished
 * nor failed, and reading it as either would be wrong.
 */
export type CallStatus = "ok" | "failed" | "refused" | "background";

export function callStatus(output: string): CallStatus {
  const text = String(output ?? "");
  if (/^Refused:/.test(text)) return "refused";
  if (/^(Error:|exit \d+|Timed out|Failed to start|Exited immediately)/.test(text)) return "failed";
  if (/^Started in the background \(pid \d+\)/.test(text)) return "background";
  return "ok";
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? flat.slice(0, 157) + "…" : flat;
}
