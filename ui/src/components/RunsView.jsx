import React, { useEffect, useState, useCallback } from "react";
import { apiFetch } from "../api.js";
import { SessionList } from "./SessionList.jsx";
import { TurnTimeline } from "./TurnTimeline.jsx";

export function RunsView({ onAuthError }) {
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
        if (err && err.status === 401) onAuthError?.(err);
      })
      .finally(() => setSessionsLoading(false));
  }, [onAuthError]);

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
          if (err && err.status === 401) onAuthError?.(err);
        })
        .finally(() => setTurnsLoading(false));
    },
    [onAuthError]
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
