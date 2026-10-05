import { Router } from 'express';
import { cursorQuery, type VideoDto } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { requireAuth, userId } from '../../middleware/auth';
import { notFound } from '../../middleware/errors';
import { validate } from '../../middleware/validate';
import { decodeCursor, encodeCursor, videoInclude } from '../common';
import { decorateVideos, publicVideoWhere } from '../catalog';

export function socialRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);

  async function requireVideo(id: string): Promise<void> {
    const v = await ctx.prisma.video.findFirst({ where: { id, ...publicVideoWhere }, select: { id: true } });
    if (!v) throw notFound('Video not found');
  }

  router.post('/videos/:id/like', auth, async (req, res) => {
    const id = String(req.params.id);
    const uid = userId(req);
    await requireVideo(id);
    const existing = await ctx.prisma.videoLike.findUnique({ where: { userId_videoId: { userId: uid, videoId: id } } });
    if (existing) await ctx.prisma.videoLike.delete({ where: { id: existing.id } });
    else await ctx.prisma.videoLike.upsert({ where: { userId_videoId: { userId: uid, videoId: id } }, update: {}, create: { userId: uid, videoId: id } });
    res.json({ liked: !existing, likesCount: await ctx.prisma.videoLike.count({ where: { videoId: id } }) });
  });

  router.post('/videos/:id/watchlist', auth, async (req, res) => {
    const id = String(req.params.id);
    const uid = userId(req);
    await requireVideo(id);
    const existing = await ctx.prisma.watchlistItem.findUnique({ where: { userId_videoId: { userId: uid, videoId: id } } });
    if (existing) await ctx.prisma.watchlistItem.delete({ where: { id: existing.id } });
    else await ctx.prisma.watchlistItem.upsert({ where: { userId_videoId: { userId: uid, videoId: id } }, update: {}, create: { userId: uid, videoId: id } });
    res.json({ inWatchlist: !existing });
  });

  router.get('/me/watchlist', auth, validate('query', cursorQuery), async (req, res) => {
    const q = req.query as unknown as { cursor?: string; limit: number };
    const uid = userId(req);
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor);
    const items = await ctx.prisma.watchlistItem.findMany({
      where: {
        userId: uid,
        video: publicVideoWhere,
        ...(cur ? { OR: [{ createdAt: { lt: new Date(cur.t) } }, { createdAt: new Date(cur.t), id: { lt: cur.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: { video: { include: videoInclude } },
    });
    const page = items.slice(0, q.limit);
    const last = page[page.length - 1];
    const videos: VideoDto[] = await decorateVideos(ctx, page.map((i) => i.video), uid);
    res.json({ items: videos, nextCursor: items.length > q.limit && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null });
  });

  return router;
}
