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

import { traitsOf } from "./tool-traits.js";

export function callDetail(name: string, args: Record<string, unknown>): string {
  // The argument that IS the call, from the traits table. A closed list: a
  // generic "first string field" would print a file's whole contents for
  // write_file.
  const keys = traitsOf(name)?.headline ?? [];
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return clip(value.trim());
  }
  // A tool with no headline (every MCP one) still says something rather
  // than nothing: its short string arguments, which is what its parameters
  // usually are.
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

/**
 * How a step's `error` says the call never reached a tool: no such tool,
 * arguments that would not parse, a required one missing.
 *
 * That is not a tool failing, and the difference is read in three places.
 * The turn loop asks "did anything run"; the face must not apologise for a
 * tool that gave no account of anything; and a reopened conversation must
 * not draw a badge the live one never showed -- nothing is announced for a
 * call that was refused before it started.
 *
 * In the error column and not the output: the output is what the model
 * reads, and its wording is the cue to try again. The column is ours.
 * Steps stored before this existed carry no mark and read as they did.
 */
export const NEVER_RAN = "never ran: ";

export function neverRan(error: string | null | undefined): boolean {
  return typeof error === "string" && error.startsWith(NEVER_RAN);
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? flat.slice(0, 157) + "…" : flat;
}
