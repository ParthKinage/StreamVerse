import type { RequestHandler } from 'express';

/** Default for every API response: never stored by a shared cache (most responses depend on who is asking). */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
};

/**
 * Lets Vercel's edge cache an anonymous response for `seconds` (and serve it stale for a while as it refreshes).
 * A request that carries an Authorization header can get user-specific data, so it is never marked cacheable.
 */
export function publicWhenAnonymous(seconds: number, staleSeconds = 300): RequestHandler {
  return (req, res, next) => {
    if (!req.headers.authorization) {
      res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${staleSeconds}`);
      res.setHeader('Vary', 'Authorization, Accept-Encoding');
    }
    next();
  };
}

/** Adds `Server-Timing: app;dur=<ms>` so the time spent inside the API is visible from the browser and in measurements. */
export const serverTiming: RequestHandler = (_req, res, next) => {
  const started = process.hrtime.bigint();
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => typeof res;
  res.writeHead = ((...args: unknown[]) => {
    if (!res.headersSent) res.setHeader('Server-Timing', `app;dur=${(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)}`);
    return writeHead(...args);
  }) as typeof res.writeHead;
  next();
};

/** A small in-process cache for values every visitor shares (categories, trending order). */
export class Memo<T> {
  private value: T | undefined;
  private until = 0;
  private pending: Promise<T> | undefined;
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(load: () => Promise<T>): Promise<T> {
    if (this.value !== undefined && this.until > this.now()) return this.value;
    this.pending ??= load()
      .then((v) => {
        this.value = v;
        this.until = this.now() + this.ttlMs;
        return v;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  clear(): void {
    this.value = undefined;
    this.until = 0;
  }
}
