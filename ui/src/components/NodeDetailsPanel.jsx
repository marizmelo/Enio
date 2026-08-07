import React, { useState } from "react";
import { entityColor } from "../utils.js";

// Side panel for a selected entity: its details plus every edge touching
// it, each with its own delete button, and a delete-entity action that
// cascades to its edges (per the API contract).
export function NodeDetailsPanel({ node, edges, entitiesById, onDeleteEdge, onDeleteEntity, onClose }) {
  const [busyEdgeId, setBusyEdgeId] = useState(null);
  const [busyEntity, setBusyEntity] = useState(false);

  if (!node) return null;

  const name = node.name && String(node.name).trim() ? node.name : "(unnamed)";
  const type = node.type || "unknown";
  const mentions = Number.isFinite(Number(node.mentions)) ? Number(node.mentions) : 0;
  const color = entityColor(type);

  const relatedEdges = (edges || []).filter((e) => e.source === node.id || e.target === node.id);

  const handleDeleteEdge = async (edge) => {
    if (!window.confirm(`Delete this "${edge.relation || "relation"}" edge?`)) return;
    setBusyEdgeId(edge.id);
    try {
      await onDeleteEdge(edge);
    } finally {
      setBusyEdgeId(null);
    }
  };

  const handleDeleteEntity = async () => {
    if (
      !window.confirm(
        `Delete entity "${name}"? This removes it and all ${relatedEdges.length} connected edge(s).`
      )
    ) {
      return;
    }
    setBusyEntity(true);
    try {
      await onDeleteEntity(node);
    } finally {
      setBusyEntity(false);
    }
  };

  return (
    <aside className="node-panel">
      <div className="node-panel-header">
        <span className="entity-swatch" style={{ background: color }} />
        <div className="node-panel-title">
          <div className="node-panel-name">{name}</div>
          <div className="node-panel-sub">
            {type} · {mentions} mention{mentions === 1 ? "" : "s"}
          </div>
        </div>
        <button type="button" className="btn btn-ghost btn-small" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="node-panel-section">
        <div className="field-label">Edges ({relatedEdges.length})</div>
        {relatedEdges.length === 0 ? (
          <div className="mono muted">No edges.</div>
        ) : (
          <ul className="edge-list" role="list">
            {relatedEdges.map((edge) => {
              const otherId = edge.source === node.id ? edge.target : edge.source;
              const other = entitiesById.get(otherId);
              const otherName = other?.name || otherId || "(unknown)";
              const direction = edge.source === node.id ? "→" : "←";
              const confidence = Number.isFinite(Number(edge.confidence))
                ? Number(edge.confidence).toFixed(2)
                : "—";
              return (
                <li key={edge.id} className="edge-item">
                  <div className="edge-item-main">
                    <span className="edge-relation">{edge.relation || "related to"}</span>
                    <span className="edge-direction">{direction}</span>
                    <span className="edge-other">{otherName}</span>
                  </div>
                  <div className="edge-item-meta">
                    <span className="mono muted">confidence {confidence}</span>
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      disabled={busyEdgeId === edge.id}
                      onClick={() => handleDeleteEdge(edge)}
                    >
                      {busyEdgeId === edge.id ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="node-panel-footer">
        <button type="button" className="btn btn-danger" disabled={busyEntity} onClick={handleDeleteEntity}>
          {busyEntity ? "Deleting…" : "Delete entity"}
        </button>
      </div>
    </aside>
  );
}
