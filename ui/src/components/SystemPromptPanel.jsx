import React, { useState } from "react";
import { splitMemoryBlock } from "../utils.js";

// The single most useful thing in the UI: the exact system prompt sent for
// a turn, with the <memory> block visually distinct so it's obvious what
// was injected into context for this specific answer.
export function SystemPromptPanel({ systemPrompt, memoryBlock }) {
  const [open, setOpen] = useState(false);

  const hasPrompt = Boolean(systemPrompt && systemPrompt.trim());
  const { before, memory, after } = splitMemoryBlock(systemPrompt, memoryBlock);
  const hasMemory = Boolean(memory && memory.trim());

  return (
    <div className={`disclosure system-prompt-disclosure ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="disclosure-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`disclosure-caret ${open ? "open" : ""}`} aria-hidden="true">
          &#9656;
        </span>
        <span className="disclosure-summary">System prompt</span>
        {hasMemory ? (
          <span className="badge badge-memory">memory injected</span>
        ) : (
          <span className="badge badge-muted">no memory</span>
        )}
      </button>
      {open && (
        <div className="disclosure-body">
          {!hasPrompt ? (
            <div className="mono muted">No system prompt recorded for this turn.</div>
          ) : (
            <pre className="mono block system-prompt-text">
              {before}
              {hasMemory && <span className="memory-highlight">{memory}</span>}
              {after}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
