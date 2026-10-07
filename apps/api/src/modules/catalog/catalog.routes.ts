import { Router } from 'express';
import { isObjectKey, type S3Store } from '@tesor_gp/storage';
import { videoListQuery, type VideoListQuery } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { optionalAuth } from '../../middleware/auth';
import { publicWhenAnonymous } from '../../middleware/http-cache';
import { validate } from '../../middleware/validate';
import * as service from './catalog.service';

const THUMB_URL_TTL_SEC = 7 * 24 * 3600;
const THUMB_URL_REUSE_MS = 24 * 3600 * 1000;

/** Signed thumbnail URLs, reused for a day (bounded) so repeat views hit the browser cache. */
const thumbnailUrls = {
  items: new Map<string, { url: string; until: number }>(),
  async get(key: string, s3: S3Store): Promise<string> {
    const hit = this.items.get(key);
    if (hit && hit.until > Date.now()) return hit.url;
    const url = await s3.signedGetUrl(key, THUMB_URL_TTL_SEC);
    if (this.items.size >= 2000) this.items.delete(this.items.keys().next().value as string);
    this.items.set(key, { url, until: Date.now() + THUMB_URL_REUSE_MS });
    return url;
  },
};

export function catalogRoutes(ctx: AppContext): Router {
  const router = Router();
  const optional = optionalAuth(ctx);

  // Anonymous lists are the same for everyone, so Vercel's edge may serve them for a short while.
  router.get('/videos', publicWhenAnonymous(30), optional, validate('query', videoListQuery), async (req, res) => {
    res.json(await service.listVideos(ctx, req.query as unknown as VideoListQuery, req.user?.id));
  });

  router.get('/videos/:id', optional, async (req, res) => {
    res.json(await service.getVideo(ctx, String(req.params.id), req.user));
  });

  router.get('/videos/:id/thumbnail', async (req, res) => {
    const file = await service.getThumbnailPath(ctx, String(req.params.id));
    if (ctx.storage.s3 && isObjectKey(file)) {
      // Redirect to a signed bucket URL. The same URL is reused for a day so the browser cache keeps working.
      res.setHeader('Cache-Control', req.query.v ? 'public, max-age=86400, immutable' : 'public, max-age=3600');
      res.redirect(302, await thumbnailUrls.get(file, ctx.storage.s3));
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('image/jpeg').sendFile(file);
  });

  router.get('/categories', publicWhenAnonymous(60), async (_req, res) => {
    res.json({ categories: await service.listCategories(ctx) });
  });

  router.get('/creators/:id', publicWhenAnonymous(60), async (req, res) => {
    res.json(await service.getCreatorProfile(ctx, String(req.params.id)));
  });

  return router;
}
