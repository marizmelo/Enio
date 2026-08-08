import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { apiFetch } from "../api.js";
import { computeForceLayout } from "../forceLayout.js";
import { EntityNode } from "./EntityNode.jsx";
import { NodeDetailsPanel } from "./NodeDetailsPanel.jsx";
import { EmptyState, Spinner, ErrorBanner } from "./Common.jsx";
import { entityColor } from "../utils.js";
import { useInspector } from "../store.js";

const NODE_TYPES = { entityNode: EntityNode };

function confidenceOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function GraphView() {
  const reportError = useInspector((s) => s.reportError);
  const [raw, setRaw] = useState(null); // { nodes, edges }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch("/api/graph?limit=300")
      .then((data) => {
        const nodes = Array.isArray(data?.nodes) ? data.nodes.filter(Boolean) : [];
        const edges = Array.isArray(data?.edges) ? data.edges.filter(Boolean) : [];
        setRaw({ nodes, edges });
      })
      .catch((err) => {
        setError(err);
        reportError(err);
      })
      .finally(() => setLoading(false));
  }, [reportError]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="graph-pane">
        <Spinner label="Loading graph" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="graph-pane">
        <ErrorBanner error={error} onRetry={load} />
      </div>
    );
  }

  if (!raw || raw.nodes.length === 0) {
    return (
      <div className="graph-pane">
        <EmptyState
          title="The knowledge graph is empty"
          hint="This fills in automatically once conversations are indexed into memory — entities enio recognizes and the relations it infers between them will appear here."
        />
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <GraphCanvas raw={raw} setRaw={setRaw} />
    </ReactFlowProvider>
  );
}

function GraphCanvas({ raw, setRaw }) {
  // Pulled straight from the store rather than passed down: this component is
  // two levels below the shell that renders the banner.
  const reportError = useInspector((s) => s.reportError);
  const { setCenter, getZoom } = useReactFlow();
  const [selectedId, setSelectedId] = useState(null);
  const [confidenceMin, setConfidenceMin] = useState(0);
  const [search, setSearch] = useState("");
  const [deleteError, setDeleteError] = useState(null);
  const layoutKey = useRef(null);
  const positionsRef = useRef(new Map());

  // Compute the force layout once per distinct graph dataset (identified by
  // the sorted node/edge id set), not on every render — positions must stay
  // stable while the user filters or selects.
  const datasetKey = useMemo(() => {
    const nodeIds = raw.nodes.map((n) => n.id).sort().join(",");
    const edgeIds = raw.edges.map((e) => `${e.source}-${e.target}`).sort().join(",");
    return `${nodeIds}|${edgeIds}`;
  }, [raw]);

  if (layoutKey.current !== datasetKey) {
    positionsRef.current = computeForceLayout(raw.nodes, raw.edges, { iterations: 200 });
    layoutKey.current = datasetKey;
  }

  const entitiesById = useMemo(() => new Map(raw.nodes.map((n) => [n.id, n])), [raw.nodes]);

  const matchedIds = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return new Set();
    const set = new Set();
    for (const n of raw.nodes) {
      if (n.name && String(n.name).toLowerCase().includes(term)) set.add(n.id);
    }
    return set;
  }, [search, raw.nodes]);

  useEffect(() => {
    if (matchedIds.size === 0) return;
    const firstId = matchedIds.values().next().value;
    const pos = positionsRef.current.get(firstId);
    if (pos) {
      setCenter(pos.x, pos.y, { zoom: Math.max(getZoom(), 1), duration: 400 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedIds]);

  const visibleEdges = useMemo(
    () =>
      raw.edges.filter((e) => {
        if (!entitiesById.has(e.source) || !entitiesById.has(e.target)) return false;
        const c = confidenceOr(e.confidence, null);
        if (c === null) return true; // unknown confidence: don't hide it
        return c >= confidenceMin;
      }),
    [raw.edges, entitiesById, confidenceMin]
  );

  const flowNodes = useMemo(
    () =>
      raw.nodes.map((n) => {
        const pos = positionsRef.current.get(n.id) || { x: 0, y: 0 };
        return {
          id: n.id,
          type: "entityNode",
          position: pos,
          data: { ...n, matched: matchedIds.has(n.id) },
          selected: n.id === selectedId,
        };
      }),
    [raw.nodes, matchedIds, selectedId]
  );

  const flowEdges = useMemo(
    () =>
      visibleEdges.map((e) => {
        const c = confidenceOr(e.confidence, 0.5);
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.relation || "",
          animated: false,
          style: { stroke: "var(--edge-color)", strokeWidth: 0.75 + c * 2.5, opacity: 0.35 + c * 0.55 },
          labelStyle: { fill: "var(--text-dim)", fontSize: 10 },
          labelBgStyle: { fill: "var(--panel-bg)", fillOpacity: 0.85 },
          data: e,
        };
      }),
    [visibleEdges]
  );

  const selectedNode = selectedId ? entitiesById.get(selectedId) : null;

  const handleNodeClick = useCallback((_evt, node) => {
    setSelectedId(node.id);
  }, []);

  const handleEdgeClick = useCallback(
    async (_evt, edge) => {
      const relation = edge?.data?.relation || "relation";
      if (!window.confirm(`Delete this "${relation}" edge?`)) return;
      setDeleteError(null);
      try {
        await apiFetch(`/api/graph/edges/${encodeURIComponent(edge.id)}`, { method: "DELETE" });
        setRaw((prev) => ({
          ...prev,
          edges: prev.edges.filter((e) => e.id !== edge.id),
        }));
      } catch (err) {
        setDeleteError(err);
        reportError(err);
      }
    },
    [setRaw, reportError]
  );

  const handleDeleteEdgeFromPanel = useCallback(
    async (edge) => {
      setDeleteError(null);
      try {
        await apiFetch(`/api/graph/edges/${encodeURIComponent(edge.id)}`, { method: "DELETE" });
        setRaw((prev) => ({ ...prev, edges: prev.edges.filter((e) => e.id !== edge.id) }));
      } catch (err) {
        setDeleteError(err);
        reportError(err);
        throw err;
      }
    },
    [setRaw, reportError]
  );

  const handleDeleteEntity = useCallback(
    async (node) => {
      setDeleteError(null);
      try {
        await apiFetch(`/api/graph/entities/${encodeURIComponent(node.id)}`, { method: "DELETE" });
        setRaw((prev) => ({
          nodes: prev.nodes.filter((n) => n.id !== node.id),
          edges: prev.edges.filter((e) => e.source !== node.id && e.target !== node.id),
        }));
        setSelectedId(null);
      } catch (err) {
        setDeleteError(err);
        reportError(err);
        throw err;
      }
    },
    [setRaw, reportError]
  );

  const legendEntries = [
    ["person", entityColor("person")],
    ["project", entityColor("project")],
    ["technology", entityColor("technology")],
    ["organization", entityColor("organization")],
    ["place", entityColor("place")],
    ["concept", entityColor("concept")],
  ];

  return (
    <div className="graph-pane">
      <div className="graph-toolbar">
        <input
          type="search"
          className="graph-search"
          placeholder="Search entities…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="confidence-slider">
          Min confidence
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={confidenceMin}
            onChange={(e) => setConfidenceMin(Number(e.target.value))}
          />
          <span className="mono">{confidenceMin.toFixed(2)}</span>
        </label>
        <div className="graph-legend">
          {legendEntries.map(([type, color]) => (
            <span key={type} className="legend-item">
              <span className="legend-swatch" style={{ background: color }} />
              {type}
            </span>
          ))}
        </div>
      </div>

      <ErrorBanner error={deleteError} onRetry={() => setDeleteError(null)} />

      <div className="graph-canvas-wrap">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          onNodeClick={handleNodeClick}
          onEdgeClick={handleEdgeClick}
          onPaneClick={() => setSelectedId(null)}
          fitView
          minZoom={0.1}
          maxZoom={2.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => entityColor(n?.data?.type)}
            maskColor="rgba(0,0,0,0.35)"
          />
        </ReactFlow>

        {selectedNode && (
          <NodeDetailsPanel
            node={selectedNode}
            edges={raw.edges.filter((e) => entitiesById.has(e.source) && entitiesById.has(e.target))}
            entitiesById={entitiesById}
            onDeleteEdge={handleDeleteEdgeFromPanel}
            onDeleteEntity={handleDeleteEntity}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}
