import React, { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./api.js";
import { RunsView } from "./components/RunsView.jsx";
import { GraphView } from "./components/GraphView.jsx";
import { ErrorBanner } from "./components/Common.jsx";
import { useInspector } from "./store.js";

const TABS = [
  { id: "runs", label: "Runs" },
  { id: "graph", label: "Graph" },
];

export function App() {
  // Tab and auth live in the store because the views set them and the shell
  // renders them. Stats stay local: nothing outside this component reads them.
  const tab = useInspector((s) => s.tab);
  const setTab = useInspector((s) => s.setTab);
  const globalAuthError = useInspector((s) => s.authError);
  const reportError = useInspector((s) => s.reportError);

  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);

  const loadStats = useCallback(() => {
    apiFetch("/api/stats")
      .then((data) => setStats(data && typeof data === "object" ? data : null))
      .catch((err) => {
        setStatsError(err);
        reportError(err);
      });
  }, [reportError]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title">
          <span className="app-title-mark">enio</span>
          <span className="app-title-sub">inspector</span>
        </div>

        <nav className="app-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`app-tab ${tab === t.id ? "is-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="app-stats">
          {stats ? (
            <>
              <StatItem label="sessions" value={stats.sessions} />
              <StatItem label="turns" value={stats.turns} />
              <StatItem label="messages" value={stats.messages} />
              <StatItem label="facts" value={stats.facts} />
              <StatItem label="entities" value={stats.entities} />
              <StatItem label="edges" value={stats.edges} />
            </>
          ) : statsError ? (
            <span className="stat-error">stats unavailable</span>
          ) : (
            <span className="stat-loading">loading stats…</span>
          )}
        </div>
      </header>

      {globalAuthError && (
        <div className="global-error">
          <ErrorBanner
            error="Not authorized — the page's session token is missing or invalid. Reload this page from the enio server so it can inject a fresh token."
          />
        </div>
      )}

      <div className="app-body">
        {tab === "runs" && <RunsView />}
        {tab === "graph" && <GraphView />}
      </div>
    </div>
  );
}

function StatItem({ label, value }) {
  const n = Number(value);
  return (
    <span className="stat-item">
      <span className="stat-value">{Number.isFinite(n) ? n.toLocaleString() : "—"}</span>
      <span className="stat-label">{label}</span>
    </span>
  );
}
