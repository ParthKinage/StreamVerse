import { Router } from 'express';
import { videoListQuery, type VideoListQuery } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { optionalAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as service from './catalog.service';

export function catalogRoutes(ctx: AppContext): Router {
  const router = Router();
  const optional = optionalAuth(ctx);

  router.get('/videos', optional, validate('query', videoListQuery), async (req, res) => {
    res.json(await service.listVideos(ctx, req.query as unknown as VideoListQuery, req.user?.id));
  });

  router.get('/videos/:id', optional, async (req, res) => {
    res.json(await service.getVideo(ctx, String(req.params.id), req.user));
  });

  router.get('/videos/:id/thumbnail', async (req, res) => {
    const file = await service.getThumbnailPath(ctx, String(req.params.id));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('image/jpeg').sendFile(file);
  });

  router.get('/categories', async (_req, res) => {
    res.json({ categories: await service.listCategories(ctx) });
  });

  router.get('/creators/:id', async (req, res) => {
    res.json(await service.getCreatorProfile(ctx, String(req.params.id)));
  });

  return router;
}
