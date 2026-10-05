import { Router, type Response } from 'express';
import { loginRequest, registerRequest } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { requireAuth, userId } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import * as service from './auth.service';

const REFRESH_COOKIE = 'refresh_token';

function setRefreshCookie(ctx: AppContext, res: Response, token: string, expires: Date): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure: ctx.env.NODE_ENV === 'production',
    path: '/api/v1/auth',
    expires,
  });
}

export function authRoutes(ctx: AppContext): Router {
  const router = Router();
  const limiter = createRateLimiter(ctx, { name: 'auth', max: ctx.env.AUTH_RATE_LIMIT_MAX });

  router.post('/register', limiter, validate('body', registerRequest), async (req, res) => {
    const session = await service.register(ctx, req.body);
    setRefreshCookie(ctx, res, session.refreshToken, session.refreshExpiresAt);
    res.status(201).json({ accessToken: session.accessToken, user: session.user });
  });

  router.post('/login', limiter, validate('body', loginRequest), async (req, res) => {
    const session = await service.login(ctx, req.body);
    setRefreshCookie(ctx, res, session.refreshToken, session.refreshExpiresAt);
    res.json({ accessToken: session.accessToken, user: session.user });
  });

  router.post('/refresh', limiter, async (req, res) => {
    const token = req.signedCookies?.[REFRESH_COOKIE] as string | undefined;
    const session = await service.refresh(ctx, token);
    setRefreshCookie(ctx, res, session.refreshToken, session.refreshExpiresAt);
    res.json({ accessToken: session.accessToken, user: session.user });
  });

  router.post('/logout', async (req, res) => {
    await service.logout(ctx, req.signedCookies?.[REFRESH_COOKIE] as string | undefined);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    res.status(204).end();
  });

  router.get('/me', requireAuth(ctx), async (req, res) => {
    res.json({ user: await service.me(ctx, userId(req)) });
  });

  return router;
}
