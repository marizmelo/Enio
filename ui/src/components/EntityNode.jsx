import React from "react";
import { Handle, Position } from "@xyflow/react";
import { entityColor } from "../utils.js";

// Node size scales with mention count (log scale so one heavily-mentioned
// entity doesn't dwarf everything else).
export function sizeForMentions(mentions) {
  const m = Number(mentions);
  const safe = Number.isFinite(m) && m > 0 ? m : 1;
  const scaled = 34 + Math.log2(safe + 1) * 12;
  return Math.max(30, Math.min(96, scaled));
}

export function EntityNode({ data, selected }) {
  const color = entityColor(data?.type);
  const size = sizeForMentions(data?.mentions);
  const name = data?.name && String(data.name).trim() ? data.name : "(unnamed)";

  return (
    <div
      className={`entity-node ${selected ? "is-selected" : ""} ${data?.matched ? "is-matched" : ""}`}
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow: data?.matched ? `0 0 0 3px ${color}` : "none",
      }}
      title={`${name} (${data?.type || "unknown"}) — ${Number(data?.mentions) || 0} mentions`}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <span className="entity-node-label">{name}</span>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}
