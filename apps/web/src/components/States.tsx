import type { ReactNode } from 'react';

export function PageSpinner({ label = 'Loading' }: { label?: string }): JSX.Element {
  return (
    <div className="page-spinner" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }): JSX.Element {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function VideoGridSkeleton({ count = 8 }: { count?: number }): JSX.Element {
  return (
    <div className="video-grid" role="status" aria-label="Loading videos">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="video-card">
          <Skeleton className="thumb" />
          <Skeleton className="line" />
          <Skeleton className="line short" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }): JSX.Element {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {children ? <p className="muted">{children}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: (() => void) | undefined }): JSX.Element {
  return (
    <div className="error-state" role="alert">
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
