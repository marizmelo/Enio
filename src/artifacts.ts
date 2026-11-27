import type { PortType } from "./abilities.js";

/**
 * What a turn CREATED, recovered from the tools' own words.
 *
 * Shared by the pipeline executor (artifact flow between nodes), the chat
 * SSE channel (the `: artifact` frame that opens the canvas), and the
 * conversation-restore path (file chips on stored replies). Its own module
 * because that last consumer lives in memory/store.ts, which pipelines.ts
 * imports -- extraction is a pure function and belongs below both.
 *
 * The matches are VERBATIM against tool output, pinned by tests: if a tool
 * rewords its message, the test failing loudly is the feature.
 */

export interface Artifact {
  type: PortType;
  /** Present for file-kind artifacts; a path the fs tools can re-resolve. */
  path?: string;
  /** Present for text artifacts. */
  text?: string;
}

/**
 * The path a write reported, from its first line.
 *
 * write_file adds where it kept the previous version when it replaces a file
 * with different contents: "Wrote 120 bytes to app.js (previous version
 * kept: stash/…-app.js)". Read to the end of the line, that whole sentence
 * was the path -- a file that does not exist -- so the test run after a
 * write found no project and was skipped without a word, and the chip for
 * the file pointed nowhere. Only on an overwrite, which is the write a test
 * run matters most for.
 *
 * One reader for both places that need it, beside the other grammar this
 * module pins.
 */
export function writtenPath(output: string): string | null {
  // The suffix as stashPrevious writes it -- stash/<stamp>-<name>, no folder
  // below that -- and nothing looser: any trailing bracket would take
  // "draft (old)" for a path with a note after it.
  const m = /^Wrote \d+ bytes to (.+?)(?: \(previous version kept: stash\/[^/\n]+\))?$/m.exec(output);
  return m ? m[1]!.trim() : null;
}

export function extractArtifacts(tool: string, output: string): Artifact[] {
  const artifacts: Artifact[] = [];
  if (tool === "write_file" || tool === "handoff_saved" || tool === "edit_file") {
    // handoff_saved is the harness recording its own save in the tool's
    // dialect (see runTurn); one grammar, two writers.
    const path = writtenPath(output);
    if (path) artifacts.push({ type: "document", path });
  } else if (tool === "take_screenshot") {
    const m = /Screenshot saved to (.+?\.png)/.exec(output);
    if (m) artifacts.push({ type: "image", path: m[1]!.trim() });
  } else if (tool === "send_email") {
    const m = /^Saved to (.+?\.eml)$/m.exec(output);
    if (m) artifacts.push({ type: "email_draft", path: m[1]!.trim() });
  } else if (tool === "propose_plan") {
    if (/^Proposed, not run\./.test(output)) artifacts.push({ type: "plan" });
  }
  return artifacts;
}
