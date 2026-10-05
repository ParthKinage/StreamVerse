import type { RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { AppContext } from '../context';

/** Redis-backed limiter that fails open if Redis is unavailable (rate limiting must not take the API down). */
export function createRateLimiter(
  ctx: Pick<AppContext, 'redis'>,
  options: { name: string; windowMs?: number; max: number; keyByUser?: boolean },
): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs ?? 60_000,
    limit: options.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: true,
    keyGenerator: (req) => (options.keyByUser && req.user ? `u:${req.user.id}` : ipKeyGenerator(req.ip ?? 'unknown')),
    store: new RedisStore({
      prefix: `rl:${options.name}:`,
      sendCommand: (command: string, ...args: string[]) =>
        ctx.redis.call(command, ...args) as Promise<number | string | (number | string)[]>,
    }),
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down' } });
    },
  });
}
