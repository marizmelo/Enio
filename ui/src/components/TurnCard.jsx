import React, { useMemo } from "react";
import { StepView } from "./StepView.jsx";
import { SystemPromptPanel } from "./SystemPromptPanel.jsx";
import { Disclosure, ExpandableText } from "./Expandable.jsx";
import { Badge } from "./Common.jsx";
import { relativeTime, formatDuration, specialistColor, specialistLabel } from "../utils.js";

export function TurnCard({ turn }) {
  const steps = Array.isArray(turn?.steps) ? turn.steps : [];
  const { repairedCount, scavengedCount, errorCount } = useMemo(() => {
    let repaired = 0;
    let scavenged = 0;
    let errored = 0;
    for (const s of steps) {
      if (!s || typeof s !== "object") continue;
      if (s.repaired) repaired += 1;
      if (s.scavenged) scavenged += 1;
      if (s.error) errored += 1;
    }
    return { repairedCount: repaired, scavengedCount: scavenged, errorCount: errored };
  }, [steps]);

  const color = specialistColor(turn?.specialist);
  const question = turn?.question && String(turn.question).trim() ? turn.question : "(no question recorded)";
  const reply = turn?.reply && String(turn.reply).trim() ? turn.reply : null;

  const iterations = Number.isFinite(Number(turn?.iterations)) ? Number(turn.iterations) : null;

  return (
    <article className="turn-card">
      <header className="turn-header">
        <span
          className="specialist-chip"
          style={{ color: color.fg, background: color.bg }}
        >
          {specialistLabel(turn?.specialist)}
        </span>
        <h3 className="turn-question">{question}</h3>
      </header>

      <div className="turn-meta">
        <span title="When this turn started">{relativeTime(turn?.startedAt)}</span>
        <span className="dot">·</span>
        <span title="Wall-clock duration">{formatDuration(turn?.durationMs)}</span>
        {iterations !== null && (
          <>
            <span className="dot">·</span>
            <span>
              {iterations} iteration{iterations === 1 ? "" : "s"}
            </span>
          </>
        )}
        {(repairedCount > 0 || scavengedCount > 0 || errorCount > 0) && (
          <span className="turn-flags">
            {repairedCount > 0 && (
              <Badge tone="warning" title={`${repairedCount} step(s) needed JSON repair`}>
                {repairedCount} repaired
              </Badge>
            )}
            {scavengedCount > 0 && (
              <Badge
                tone="danger"
                title={`${scavengedCount} step(s) had their tool call recovered from plain text`}
              >
                {scavengedCount} scavenged
              </Badge>
            )}
            {errorCount > 0 && (
              <Badge tone="danger" title={`${errorCount} step(s) errored`}>
                {errorCount} error{errorCount === 1 ? "" : "s"}
              </Badge>
            )}
          </span>
        )}
      </div>

      <SystemPromptPanel systemPrompt={turn?.systemPrompt} memoryBlock={turn?.memoryBlock} />

      <Disclosure
        summary={`Steps (${steps.length})`}
        badges={
          steps.length === 0 ? null : (
            <>
              {repairedCount > 0 && <Badge tone="warning">{repairedCount}R</Badge>}
              {scavengedCount > 0 && <Badge tone="danger">{scavengedCount}S</Badge>}
            </>
          )
        }
      >
        {steps.length === 0 ? (
          <div className="mono muted">No steps recorded for this turn.</div>
        ) : (
          <div className="step-list">
            {steps.map((step, i) => (
              <StepView key={step?.seq ?? i} step={step} index={i} />
            ))}
          </div>
        )}
      </Disclosure>

      <div className="turn-reply">
        <div className="field-label">Reply</div>
        {reply ? (
          <ExpandableText text={reply} max={600} className="reply-text" />
        ) : (
          <div className="mono muted">(no reply recorded)</div>
        )}
      </div>
    </article>
  );
}
