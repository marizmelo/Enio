import React from "react";

export function Spinner({ label = "Loading" }) {
  return (
    <div className="spinner-row" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="spinner-label">{label}</span>
    </div>
  );
}

export function ErrorBanner({ error, onRetry }) {
  if (!error) return null;
  const message = typeof error === "string" ? error : error.message || "Something went wrong.";
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="btn btn-ghost btn-small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, hint, children }) {
  return (
    <div className="empty-state">
      <div className="empty-state-title">{title}</div>
      {hint && <div className="empty-state-hint">{hint}</div>}
      {children}
    </div>
  );
}

export function Badge({ tone = "default", children, title }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}
