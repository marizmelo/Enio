import React, { useMemo, useState } from "react";
import { TurnCard } from "./TurnCard.jsx";
import { EmptyState, Spinner, ErrorBanner } from "./Common.jsx";
import { specialistLabel } from "../utils.js";

function turnHasFlag(turn) {
  const steps = Array.isArray(turn?.steps) ? turn.steps : [];
  return steps.some((s) => s && typeof s === "object" && (s.repaired || s.scavenged));
}

export function TurnTimeline({ turns, loading, error, onRetry, sessionSelected }) {
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [specialistFilter, setSpecialistFilter] = useState("all");

  const specialists = useMemo(() => {
    const set = new Set();
    for (const t of turns || []) {
      set.add(specialistLabel(t?.specialist));
    }
    return Array.from(set).sort();
  }, [turns]);

  const filtered = useMemo(() => {
    return (turns || []).filter((t) => {
      if (onlyFlagged && !turnHasFlag(t)) return false;
      if (specialistFilter !== "all" && specialistLabel(t?.specialist) !== specialistFilter) {
        return false;
      }
      return true;
    });
  }, [turns, onlyFlagged, specialistFilter]);

  if (!sessionSelected) {
    return (
      <div className="timeline-pane">
        <EmptyState
          title="Select a session"
          hint="Pick a session on the left to see its turns."
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="timeline-pane">
        <Spinner label="Loading turns" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="timeline-pane">
        <ErrorBanner error={error} onRetry={onRetry} />
      </div>
    );
  }

  if (!turns || turns.length === 0) {
    return (
      <div className="timeline-pane">
        <EmptyState
          title="No turns in this session"
          hint="This session has no recorded turns yet."
        />
      </div>
    );
  }

  return (
    <div className="timeline-pane">
      <div className="timeline-filters">
        <label className="filter-checkbox">
          <input
            type="checkbox"
            checked={onlyFlagged}
            onChange={(e) => setOnlyFlagged(e.target.checked)}
          />
          Only repaired / scavenged
        </label>
        <label className="filter-select">
          Specialist
          <select value={specialistFilter} onChange={(e) => setSpecialistFilter(e.target.value)}>
            <option value="all">All</option>
            {specialists.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <span className="timeline-count">
          {filtered.length} of {turns.length} turn{turns.length === 1 ? "" : "s"}
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No turns match this filter" hint="Try clearing the filters above." />
      ) : (
        <div className="timeline">
          {filtered.map((turn, i) => (
            <TurnCard key={turn?.id ?? i} turn={turn} />
          ))}
        </div>
      )}
    </div>
  );
}
