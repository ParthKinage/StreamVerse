import type { Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '@tesor_gp/shared';
import type { AppContext } from '../context';
import { AppError, forbidden, unauthenticated } from './errors';

export interface AuthUser {
  id: string;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export function signAccessToken(ctx: Pick<AppContext, 'env'>, user: AuthUser): string {
  return jwt.sign({ role: user.role }, ctx.env.JWT_SECRET, {
    subject: user.id,
    expiresIn: ctx.env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
    algorithm: 'HS256',
  });
}

function parseBearer(req: Request, secret: string): AuthUser | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(header.slice(7), secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (!payload.sub || typeof payload.role !== 'string') return null;
    return { id: payload.sub, role: payload.role as Role };
  } catch {
    return null;
  }
}

/**
 * Suspension is checked on every signed-in request, so it takes effect at once instead of when the access token
 * expires. The answer is kept for a few seconds per user so this costs at most one small query per user every
 * SUSPENSION_CACHE_MS; suspending or restoring an account clears its entry.
 */
const SUSPENSION_CACHE_MS = 30_000;
const suspension = new Map<string, { suspended: boolean; until: number }>();

export function forgetSuspension(userId: string): void {
  suspension.delete(userId);
}

async function isSuspended(ctx: Pick<AppContext, 'prisma'>, userId: string): Promise<boolean> {
  const hit = suspension.get(userId);
  if (hit && hit.until > Date.now()) return hit.suspended;
  try {
    const row = await ctx.prisma.user.findUnique({ where: { id: userId }, select: { suspendedAt: true } });
    const suspended = Boolean(row?.suspendedAt);
    if (suspension.size > 10_000) suspension.clear();
    suspension.set(userId, { suspended, until: Date.now() + SUSPENSION_CACHE_MS });
    return suspended;
  } catch {
    // A database hiccup must not lock everyone out; the next request checks again.
    return false;
  }
}

export const accountSuspended = (): AppError => new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended. Contact support if you think this is a mistake.');

/** Rejects requests without a valid access token, or from a suspended account. */
export function requireAuth(ctx: Pick<AppContext, 'env' | 'prisma'>): RequestHandler {
  return (req, _res, next) => {
    const user = parseBearer(req, ctx.env.JWT_SECRET);
    if (!user) return next(unauthenticated('Missing or invalid access token'));
    req.user = user;
    isSuspended(ctx, user.id).then(
      (suspended) => next(suspended ? accountSuspended() : undefined),
      (err) => next(err),
    );
  };
}

/** Attaches req.user when a valid token is present; continues anonymously otherwise. */
export function optionalAuth(ctx: Pick<AppContext, 'env'>): RequestHandler {
  return (req, _res, next) => {
    const user = parseBearer(req, ctx.env.JWT_SECRET);
    if (user) req.user = user;
    next();
  };
}

/** Role check that reads the role from the database (so demotion takes effect immediately). */
export function requireRole(ctx: Pick<AppContext, 'prisma'>, ...roles: Role[]): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (!req.user) return next(unauthenticated());
      const row = await ctx.prisma.user.findUnique({ where: { id: req.user.id }, select: { role: true } });
      if (!row || !roles.includes(row.role)) return next(forbidden('Insufficient role'));
      req.user.role = row.role;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function userId(req: Request): string {
  if (!req.user) throw unauthenticated();
  return req.user.id;
}
