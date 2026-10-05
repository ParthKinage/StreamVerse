import { Router } from 'express';
import type { AppContext } from '../../context';
import { requireAuth, userId } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rateLimit';
import { purchaseVideo } from './purchase.service';

export function purchaseRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const limiter = createRateLimiter(ctx, { name: 'purchase', max: 30, keyByUser: true });
  router.post('/videos/:id/purchase', auth, limiter, async (req, res) => {
    res.json(await purchaseVideo(ctx, userId(req), String(req.params.id)));
  });
  return router;
}
