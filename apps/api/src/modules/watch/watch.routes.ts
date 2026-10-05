import { Router } from 'express';
import { cursorQuery, endSessionRequest, heartbeatRequest, startSessionRequest } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { optionalAuth, requireAuth, userId } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rateLimit';
import { unauthenticated } from '../../middleware/errors';
import { validate } from '../../middleware/validate';
import { setPlaybackCookie, verifyEndToken } from '../playback';
import * as service from './watch.service';

export function watchRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const startLimiter = createRateLimiter(ctx, { name: 'watch-start', max: 30, keyByUser: true });
  const beatLimiter = createRateLimiter(ctx, { name: 'watch-beat', max: 120, keyByUser: true });

  router.post('/watch/sessions', auth, startLimiter, validate('body', startSessionRequest), async (req, res) => {
    const { response, userId: uid } = await service.startSession(ctx, userId(req), req.body.videoId);
    setPlaybackCookie(ctx, res, response.sessionId, uid);
    res.status(201).json(response);
  });

  router.post('/watch/sessions/:id/heartbeat', auth, beatLimiter, validate('body', heartbeatRequest), async (req, res) => {
    const sessionId = String(req.params.id);
    const { response, renewCookie } = await service.heartbeat(ctx, userId(req), sessionId, req.body);
    if (renewCookie) setPlaybackCookie(ctx, res, sessionId, userId(req));
    res.json(response);
  });

  // Accepts a Bearer token, or the endToken from the start response so navigator.sendBeacon can end the session.
  router.post('/watch/sessions/:id/end', optionalAuth(ctx), validate('body', endSessionRequest), async (req, res) => {
    const sessionId = String(req.params.id);
    const body = (req.body ?? {}) as { endToken?: string };
    if (!req.user && !(body.endToken && verifyEndToken(sessionId, body.endToken, ctx.env.PLAYBACK_SIGNING_SECRET))) {
      throw unauthenticated('Missing credentials');
    }
    res.json(await service.endSession(ctx, sessionId, req.user?.id, 'USER_ENDED'));
  });

  router.get('/me/history', auth, validate('query', cursorQuery), async (req, res) => {
    const q = req.query as unknown as { cursor?: string; limit: number };
    res.json(await service.listHistory(ctx, userId(req), q.cursor, q.limit));
  });

  router.get('/me/continue-watching', auth, async (req, res) => {
    res.json(await service.continueWatching(ctx, userId(req)));
  });

  return router;
}
