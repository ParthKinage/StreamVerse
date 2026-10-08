import { Router } from 'express';
import type { AppContext } from '../../context';
import { requireAuth, userId } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rateLimit';
import { purchaseAccess } from './purchase.service';

export function purchaseRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const limiter = createRateLimiter(ctx, { name: 'purchase', max: 30, keyByUser: true });
  // Live streams (and their recordings) are bought once for permanent access; other videos are paid per second while
  // watching and answer 410 here.
  router.post('/videos/:id/purchase', auth, limiter, async (req, res) => {
    res.json(await purchaseAccess(ctx, userId(req), String(req.params.id)));
  });
  return router;
}
