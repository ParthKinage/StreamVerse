import { Router } from 'express';
import { cursorQuery, type CreatorProfileDto, type VideoDto } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { requireAuth, userId } from '../../middleware/auth';
import { badRequest, notFound } from '../../middleware/errors';
import { validate } from '../../middleware/validate';
import { decodeCursor, encodeCursor, videoInclude } from '../common';
import { creatorsToDto, decorateVideos, listVideos, liveNowWhere, ownedVideoIds, publicVideoWhere } from '../catalog';

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

  router.post('/creators/:id/follow', auth, async (req, res) => {
    const creatorId = String(req.params.id);
    const uid = userId(req);
    const creator = await ctx.prisma.creatorProfile.findUnique({ where: { id: creatorId }, select: { userId: true } });
    if (!creator) throw notFound('Channel not found');
    if (creator.userId === uid) throw badRequest('VALIDATION_ERROR', 'You cannot follow your own channel');
    const existing = await ctx.prisma.follow.findUnique({ where: { followerId_creatorId: { followerId: uid, creatorId } } });
    if (existing) await ctx.prisma.follow.delete({ where: { id: existing.id } });
    else await ctx.prisma.follow.upsert({ where: { followerId_creatorId: { followerId: uid, creatorId } }, update: {}, create: { followerId: uid, creatorId } });
    res.json({ following: !existing, followersCount: await ctx.prisma.follow.count({ where: { creatorId } }) });
  });

  /** The channels the viewer follows, most recently followed first. */
  router.get('/me/following', auth, async (req, res) => {
    const uid = userId(req);
    const rows = await ctx.prisma.follow.findMany({
      where: { followerId: uid },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { creator: { include: { user: { select: { username: true } } } } },
    });
    const items: CreatorProfileDto[] = await creatorsToDto(ctx, rows.map((r) => r.creator), uid);
    res.json({ items });
  });

  /** New videos from followed channels, newest first; the first page starts with any of them that are live now. */
  router.get('/me/feed', auth, validate('query', cursorQuery), async (req, res) => {
    const q = req.query as unknown as { cursor?: string; limit: number };
    const uid = userId(req);
    const followed = await ctx.prisma.follow.findMany({ where: { followerId: uid }, select: { creatorId: true } });
    if (followed.length === 0) return void res.json({ items: [], nextCursor: null });
    const creatorIds = followed.map((f) => f.creatorId);
    const page = await listVideos(ctx, { sort: 'newest', limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) }, uid, { creatorId: { in: creatorIds } });
    if (!q.cursor) {
      const live = await ctx.prisma.video.findMany({ where: { ...liveNowWhere, creatorId: { in: creatorIds } }, include: videoInclude, orderBy: { createdAt: 'desc' }, take: 12 });
      page.items = [...(await decorateVideos(ctx, live, uid)), ...page.items];
    }
    res.json(page);
  });

  /** Ids of the videos the viewer owns, so any list can mark them without per-viewer lists (which the edge cannot cache). */
  router.get('/me/owned', auth, async (req, res) => {
    res.json({ videoIds: await ownedVideoIds(ctx, userId(req)) });
  });

  return router;
}
