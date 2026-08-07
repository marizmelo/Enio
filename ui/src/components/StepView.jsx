import React from "react";
import { ExpandableText } from "./Expandable.jsx";
import { Badge } from "./Common.jsx";
import { prettyJson, formatDuration } from "../utils.js";

// A single step within a turn: either a "tool" call/result or a "model"
// generation. Repaired/scavenged steps get a visible warning badge — that's
// the whole point of surfacing steps at this granularity.
export function StepView({ step, index }) {
  if (!step || typeof step !== "object") {
    return (
      <div className="step step-broken">
        <span className="step-index">{index + 1}</span>
        <span className="mono muted">Malformed step data.</span>
      </div>
    );
  }

  const kind = step.kind === "tool" ? "tool" : step.kind === "model" ? "model" : "unknown";
  const hasError = Boolean(step.error);
  const repaired = Boolean(step.repaired);
  const scavenged = Boolean(step.scavenged);

  return (
    <div className={`step step-${kind} ${hasError ? "step-error" : ""}`}>
      <div className="step-header">
        <span className="step-index">{index + 1}</span>
        <span className={`step-kind step-kind-${kind}`}>{kind}</span>
        {kind === "tool" && (
          <span className="step-name mono">{step.name || "(unnamed tool)"}</span>
        )}
        <span className="step-spacer" />
        {repaired && (
          <Badge tone="warning" title="The model's tool-call JSON was malformed and had to be repaired.">
            repaired
          </Badge>
        )}
        {scavenged && (
          <Badge tone="danger" title="The tool call wasn't structured output at all — it was recovered from plain text.">
            scavenged
          </Badge>
        )}
        {hasError && <Badge tone="danger">error</Badge>}
        <span className="step-duration">{formatDuration(step.durationMs)}</span>
      </div>

      <div className="step-body">
        {kind === "tool" && (
          <>
            <Field label="Arguments">
              <ExpandableText text={prettyJson(step.args)} placeholder="(no arguments)" />
            </Field>
            <Field label="Result">
              <ExpandableText text={prettyJson(step.output) || step.output} placeholder="(no output)" />
            </Field>
          </>
        )}
        {kind === "model" && (
          <>
            {step.reasoning ? (
              <Field label="Reasoning">
                <ExpandableText text={step.reasoning} className="reasoning-text" />
              </Field>
            ) : null}
            <Field label="Raw content">
              <ExpandableText text={step.rawContent} placeholder="(no raw content recorded)" />
            </Field>
          </>
        )}
        {kind === "unknown" && (
          <Field label="Raw step">
            <ExpandableText text={prettyJson(step)} />
          </Field>
        )}
        {hasError && (
          <Field label="Error">
            <div className="mono error-text">{String(step.error)}</div>
          </Field>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {children}
    </div>
  );
}
