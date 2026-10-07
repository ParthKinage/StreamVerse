import { Router } from 'express';
import { recommendationsQuery } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { optionalAuth } from '../../middleware/auth';
import { publicWhenAnonymous } from '../../middleware/http-cache';
import { validate } from '../../middleware/validate';
import { recommend } from './recommendations.service';

export function recommendationRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get('/recommendations', publicWhenAnonymous(30), optionalAuth(ctx), validate('query', recommendationsQuery), async (req, res) => {
    const q = req.query as unknown as { videoId?: string; limit: number };
    res.json(await recommend(ctx, q, req.user?.id));
  });
  return router;
}
