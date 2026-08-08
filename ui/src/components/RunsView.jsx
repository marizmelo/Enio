import React, { useEffect, useState, useCallback } from "react";
import { apiFetch } from "../api.js";
import { SessionList } from "./SessionList.jsx";
import { TurnTimeline } from "./TurnTimeline.jsx";
import { useInspector } from "../store.js";

export function RunsView() {
  const reportError = useInspector((s) => s.reportError);
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState(null);

  const [selectedId, setSelectedId] = useState(null);
  const [turns, setTurns] = useState([]);
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [turnsError, setTurnsError] = useState(null);

  const loadSessions = useCallback(() => {
    setSessionsLoading(true);
    setSessionsError(null);
    apiFetch("/api/sessions")
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setSessions(list);
      })
      .catch((err) => {
        setSessionsError(err);
        reportError(err);
      })
      .finally(() => setSessionsLoading(false));
  }, [reportError]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const loadTurns = useCallback(
    (id) => {
      if (!id) return;
      setTurnsLoading(true);
      setTurnsError(null);
      apiFetch(`/api/sessions/${encodeURIComponent(id)}/turns`)
        .then((data) => {
          const list = Array.isArray(data) ? data : [];
          setTurns(list);
        })
        .catch((err) => {
          setTurnsError(err);
          reportError(err);
        })
        .finally(() => setTurnsLoading(false));
    },
    [reportError]
  );

  const handleSelect = (id) => {
    setSelectedId(id);
    loadTurns(id);
  };

  return (
    <div className="runs-view">
      <aside className="runs-sidebar">
        <div className="pane-title">Sessions</div>
        <SessionList
          sessions={sessions}
          loading={sessionsLoading}
          error={sessionsError}
          onRetry={loadSessions}
          selectedId={selectedId}
          onSelect={handleSelect}
        />
      </aside>
      <main className="runs-main">
        <TurnTimeline
          turns={turns}
          loading={turnsLoading}
          error={turnsError}
          onRetry={() => loadTurns(selectedId)}
          sessionSelected={Boolean(selectedId)}
        />
      </main>
    </div>
  );
}
