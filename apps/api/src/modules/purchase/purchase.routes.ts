import { Router } from 'express';
import type { AppContext } from '../../context';
import { requireAuth } from '../../middleware/auth';
import { AppError } from '../../middleware/errors';
import { createRateLimiter } from '../../middleware/rateLimit';

export function purchaseRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const limiter = createRateLimiter(ctx, { name: 'purchase', max: 30, keyByUser: true });
  // Per-second billing replaced the one-time unlock: viewers pay for the seconds they are sent while watching.
  router.post('/videos/:id/purchase', auth, limiter, () => {
    throw new AppError(410, 'NOT_AVAILABLE_IN_THIS_MODE', 'Videos are now paid per second while you watch; just press play');
  });
  return router;
}
