import type { RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { AppContext } from '../context';

/**
 * Rate limiter. `store: 'redis'` (default) shares counts across instances and fails open if Redis is unavailable;
 * it is used for sign-in, payments, uploads and watching. `store: 'memory'` costs no network round trip and is used
 * for the global per-IP limit on a single instance, so a slow or distant Redis never delays every request.
 */
export function createRateLimiter(
  ctx: Pick<AppContext, 'redis'>,
  options: { name: string; windowMs?: number; max: number; keyByUser?: boolean; store?: 'redis' | 'memory' },
): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs ?? 60_000,
    limit: options.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: true,
    keyGenerator: (req) => (options.keyByUser && req.user ? `u:${req.user.id}` : ipKeyGenerator(req.ip ?? 'unknown')),
    ...(options.store === 'memory'
      ? {}
      : {
          store: new RedisStore({
            prefix: `rl:${options.name}:`,
            sendCommand: (command: string, ...args: string[]) =>
              ctx.redis.call(command, ...args) as Promise<number | string | (number | string)[]>,
          }),
        }),
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down' } });
    },
  });
}
