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

export function extractArtifacts(tool: string, output: string): Artifact[] {
  const artifacts: Artifact[] = [];
  if (tool === "write_file" || tool === "handoff_saved") {
    // handoff_saved is the harness recording its own save in the tool's
    // dialect (see runTurn); one grammar, two writers.
    const m = /^Wrote \d+ bytes to (.+)$/m.exec(output);
    if (m) artifacts.push({ type: "document", path: m[1]!.trim() });
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
