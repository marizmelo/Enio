import React, { useState } from "react";
import { truncate, isTruncatable } from "../utils.js";

// Collapsible block of monospace text (tool args/output, raw model content).
// Truncates long text by default with an expand/collapse toggle.
export function ExpandableText({ text, max = 400, placeholder = "(empty)", className = "" }) {
  const [expanded, setExpanded] = useState(false);
  const value = text === null || text === undefined || text === "" ? "" : String(text);

  if (!value) {
    return <div className={`mono muted ${className}`}>{placeholder}</div>;
  }

  const canTruncate = isTruncatable(value, max);
  const shown = expanded || !canTruncate ? value : truncate(value, max);

  return (
    <div className={`expandable ${className}`}>
      <pre className="mono block">{shown}{!expanded && canTruncate ? "…" : ""}</pre>
      {canTruncate && (
        <button type="button" className="btn btn-link" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : `Show all (${value.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

// Generic disclosure section with a clickable header.
export function Disclosure({ summary, defaultOpen = false, children, badges = null, className = "" }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`disclosure ${open ? "is-open" : ""} ${className}`}>
      <button
        type="button"
        className="disclosure-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`disclosure-caret ${open ? "open" : ""}`} aria-hidden="true">
          &#9656;
        </span>
        <span className="disclosure-summary">{summary}</span>
        {badges && <span className="disclosure-badges">{badges}</span>}
      </button>
      {open && <div className="disclosure-body">{children}</div>}
    </div>
  );
}
