import type { Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '@tesor_gp/shared';
import type { AppContext } from '../context';
import { forbidden, unauthenticated } from './errors';

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

/** Rejects requests without a valid access token. */
export function requireAuth(ctx: Pick<AppContext, 'env'>): RequestHandler {
  return (req, _res, next) => {
    const user = parseBearer(req, ctx.env.JWT_SECRET);
    if (!user) return next(unauthenticated('Missing or invalid access token'));
    req.user = user;
    next();
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
