import type { AiCandidate, RecommendationsResponse, VideoDto } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { videoInclude, type VideoWithCreator } from '../common';
import { decorateVideos, publicVideoWhere, trendingVideoIds } from '../catalog';

const CANDIDATE_LIMIT = 300;

const toCandidate = (v: VideoWithCreator): AiCandidate => ({
  id: v.id,
  title: v.title,
  description: v.description,
  category: v.category,
  tags: v.tags,
  creatorId: v.creatorId,
  views: v.viewsCount,
  createdAt: v.createdAt.toISOString(),
});

async function fetchOrdered(ctx: AppContext, ids: string[], viewerId?: string): Promise<VideoDto[]> {
  if (ids.length === 0) return [];
  const rows = await ctx.prisma.video.findMany({ where: { id: { in: ids }, ...publicVideoWhere }, include: videoInclude });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter((v): v is VideoWithCreator => Boolean(v));
  return decorateVideos(ctx, ordered, viewerId);
}

/** Trending (completed views in the last 7 days), then most viewed/newest. Never depends on the AI service. */
export async function fallbackRecommendations(ctx: AppContext, limit: number, excludeId?: string, viewerId?: string): Promise<VideoDto[]> {
  return fetchOrdered(ctx, await trendingVideoIds(ctx, limit, 0, excludeId), viewerId);
}

export async function recommend(ctx: AppContext, query: { videoId?: string | undefined; limit: number }, viewerId?: string): Promise<RecommendationsResponse> {
  // Without an AI service, loading 300 candidates and the viewer's history would be wasted work.
  if (ctx.ai.enabled === false) return { items: await fallbackRecommendations(ctx, query.limit, query.videoId, viewerId), source: 'fallback' };
  try {
    const rows = await ctx.prisma.video.findMany({
      where: publicVideoWhere,
      include: videoInclude,
      orderBy: [{ viewsCount: 'desc' }, { createdAt: 'desc' }],
      take: CANDIDATE_LIMIT,
    });
    const seedRow = query.videoId ? rows.find((r) => r.id === query.videoId) : undefined;
    const sessions = viewerId
      ? await ctx.prisma.watchSession.findMany({
          where: { userId: viewerId, verifiedDurationSeconds: { gt: 0 } },
          orderBy: { startedAt: 'desc' },
          take: 100,
          select: { videoId: true, verifiedDurationSeconds: true, video: { select: { category: true, tags: true, creatorId: true } } },
        })
      : [];
    const ai = await ctx.ai.recommend({
      limit: query.limit,
      ...(seedRow ? { seedVideo: toCandidate(seedRow) } : {}),
      history: sessions.map((s) => ({
        category: s.video.category,
        tags: s.video.tags,
        creatorId: s.video.creatorId,
        watchedSeconds: s.verifiedDurationSeconds,
      })),
      candidates: rows.map(toCandidate),
      watchedVideoIds: Array.from(new Set(sessions.map((s) => s.videoId))),
    });
    if (ai && ai.items.length > 0) {
      const ids = ai.items.map((i) => i.id).filter((id) => id !== query.videoId).slice(0, query.limit);
      const items = await fetchOrdered(ctx, ids, viewerId);
      if (items.length > 0) return { items, source: 'ai' };
    }
  } catch (err) {
    ctx.logger.warn({ err: (err as Error).message }, 'recommendations failed; using fallback');
  }
  return { items: await fallbackRecommendations(ctx, query.limit, query.videoId, viewerId), source: 'fallback' };
}
