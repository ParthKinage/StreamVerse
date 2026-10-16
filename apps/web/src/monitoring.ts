/**
 * Error tracking (Sentry) for the website. Off unless VITE_SENTRY_DSN is set at build time; only then is the SDK
 * downloaded, so it costs nothing otherwise. No personal details are sent.
 */
let report: ((error: unknown) => void) | null = null;

export function initMonitoring(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  void import('@sentry/react').then((Sentry) => {
    Sentry.init({ dsn, environment: import.meta.env.MODE, dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false }, tracesSampleRate: 0 });
    report = (error) => Sentry.captureException(error);
  });
}

/** Reports an error a page could not recover from; does nothing when monitoring is off. */
export function reportError(error: unknown): void {
  report?.(error);
}
