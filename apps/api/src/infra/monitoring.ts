import type * as SentryNode from '@sentry/node';

/**
 * Error tracking (Sentry). Off unless SENTRY_DSN is set, and the SDK is only loaded then, so tests and development
 * never send anything. No user details, cookies, headers, query strings or request bodies are sent.
 */
let sentry: typeof SentryNode | null = null;

export async function initMonitoring(dsn: string | undefined, environment: string): Promise<boolean> {
  if (!dsn) return false;
  sentry = await import('@sentry/node');
  sentry.init({ dsn, environment, dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false }, tracesSampleRate: 0 });
  return true;
}

/** Reports an unexpected error; does nothing when monitoring is off. */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  sentry?.captureException(err, context ? { extra: context } : undefined);
}
