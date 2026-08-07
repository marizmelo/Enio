import React from "react";
import { relativeTime } from "../utils.js";
import { EmptyState, Spinner, ErrorBanner } from "./Common.jsx";

export function SessionList({ sessions, loading, error, onRetry, selectedId, onSelect }) {
  if (loading) {
    return (
      <div className="session-list">
        <Spinner label="Loading sessions" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="session-list">
        <ErrorBanner error={error} onRetry={onRetry} />
      </div>
    );
  }

  if (!sessions || sessions.length === 0) {
    return (
      <div className="session-list">
        <EmptyState
          title="No sessions yet"
          hint="Talk to enio in the CLI or desktop app — sessions show up here once a conversation is recorded."
        />
      </div>
    );
  }

  return (
    <ul className="session-list" role="list">
      {sessions.map((s) => {
        if (!s || typeof s !== "object" || !s.id) return null;
        const active = s.id === selectedId;
        const summary = s.summary && String(s.summary).trim() ? s.summary : "(no summary yet)";
        const turnCount = Number.isFinite(Number(s.turnCount)) ? Number(s.turnCount) : 0;
        return (
          <li key={s.id}>
            <button
              type="button"
              className={`session-item ${active ? "is-active" : ""}`}
              onClick={() => onSelect(s.id)}
            >
              <div className="session-item-top">
                <span className="session-time">{relativeTime(s.startedAt)}</span>
                <span className="session-turns">
                  {turnCount} turn{turnCount === 1 ? "" : "s"}
                </span>
              </div>
              <div className="session-summary">{summary}</div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
