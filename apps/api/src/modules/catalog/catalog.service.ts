import fs from 'node:fs';
import { CATEGORIES, type CreatorProfileDto, type VideoDto, type VideoListQuery, type VideoListResponse } from '@tesor_gp/shared';
import type { Prisma } from '@tesor_gp/database';
import type { AppContext } from '../../context';
import { notFound } from '../../middleware/errors';
import { decodeCursor, encodeCursor, videoInclude, videoToDto, type VideoWithCreator } from '../common';

export const publicVideoWhere: Prisma.VideoWhereInput = { isPublished: true, processingStatus: 'COMPLETED', archivedAt: null };

/** Adds per-user flags (liked, in watchlist) and like counts to a page of videos. */
export async function decorateVideos(ctx: AppContext, videos: VideoWithCreator[], viewerId?: string): Promise<VideoDto[]> {
  if (videos.length === 0) return [];
  const ids = videos.map((v) => v.id);
  const now = ctx.now();
  const [likeCounts, liked, watch, purchases] = await Promise.all([
    ctx.prisma.videoLike.groupBy({ by: ['videoId'], where: { videoId: { in: ids } }, _count: { _all: true } }),
    viewerId ? ctx.prisma.videoLike.findMany({ where: { userId: viewerId, videoId: { in: ids } }, select: { videoId: true } }) : Promise.resolve([]),
    viewerId ? ctx.prisma.watchlistItem.findMany({ where: { userId: viewerId, videoId: { in: ids } }, select: { videoId: true } }) : Promise.resolve([]),
    viewerId
      ? ctx.prisma.videoPurchase.findMany({ where: { userId: viewerId, videoId: { in: ids }, expiresAt: { gt: now } }, select: { videoId: true, expiresAt: true }, orderBy: { expiresAt: 'asc' } })
      : Promise.resolve([]),
  ]);
  const counts = new Map(likeCounts.map((c) => [c.videoId, c._count._all]));
  const likedSet = new Set(liked.map((l) => l.videoId));
  const watchSet = new Set(watch.map((w) => w.videoId));
  const accessUntil = new Map(purchases.map((p) => [p.videoId, p.expiresAt.toISOString()]));
  return videos.map((v) =>
    videoToDto(v, {
      likesCount: counts.get(v.id) ?? 0,
      ...(viewerId ? { liked: likedSet.has(v.id), inWatchlist: watchSet.has(v.id), accessUntil: accessUntil.get(v.id) ?? null } : {}),
    }),
  );
}

/** Video ids ordered by completed views in the last 7 days, then newest. Used by sort=trending and as AI fallback. */
export async function trendingVideoIds(ctx: AppContext, limit: number, offset = 0, excludeId?: string): Promise<string[]> {
  const since = new Date(ctx.now().getTime() - 7 * 86_400_000);
  const recent = await ctx.prisma.watchSession.groupBy({
    by: ['videoId'],
    where: { viewCounted: true, startedAt: { gte: since }, video: publicVideoWhere },
    _count: { _all: true },
    orderBy: { _count: { videoId: 'desc' } },
    take: 500,
  });
  const ranked = recent.map((r) => r.videoId).filter((id) => id !== excludeId);
  const rest = await ctx.prisma.video.findMany({
    where: { ...publicVideoWhere, id: { notIn: [...ranked, ...(excludeId ? [excludeId] : [])] } },
    orderBy: [{ viewsCount: 'desc' }, { createdAt: 'desc' }],
    take: offset + limit,
    select: { id: true },
  });
  return [...ranked, ...rest.map((r) => r.id)].slice(offset, offset + limit);
}

export async function listVideos(ctx: AppContext, query: VideoListQuery, viewerId?: string): Promise<VideoListResponse> {
  const filters: Prisma.VideoWhereInput[] = [publicVideoWhere];
  if (query.category) filters.push({ category: query.category });
  if (query.creatorId) filters.push({ creatorId: query.creatorId });
  if (query.q) {
    const q = query.q;
    filters.push({
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { tags: { has: q.toLowerCase() } },
        { creator: { channelName: { contains: q, mode: 'insensitive' } } },
      ],
    });
  }

  if (query.sort === 'trending') {
    const cur = decodeCursor<{ o: number }>(query.cursor);
    const offset = cur?.o ?? 0;
    const ids = await trendingVideoIds(ctx, query.limit + 1, offset);
    const matching = await ctx.prisma.video.findMany({ where: { AND: [...filters, { id: { in: ids } }] }, include: videoInclude });
    const byId = new Map(matching.map((v) => [v.id, v]));
    const ordered = ids.map((id) => byId.get(id)).filter((v): v is VideoWithCreator => Boolean(v));
    const page = ordered.slice(0, query.limit);
    return { items: await decorateVideos(ctx, page, viewerId), nextCursor: ids.length > query.limit ? encodeCursor({ o: offset + query.limit }) : null };
  }

  const popular = query.sort === 'popular';
  const cur = decodeCursor<{ v?: number; t: string; id: string }>(query.cursor);
  if (cur) {
    const t = new Date(cur.t);
    filters.push(
      popular && cur.v !== undefined
        ? { OR: [{ viewsCount: { lt: cur.v } }, { viewsCount: cur.v, createdAt: { lt: t } }, { viewsCount: cur.v, createdAt: t, id: { lt: cur.id } }] }
        : { OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: cur.id } }] },
    );
  }
  const rows = await ctx.prisma.video.findMany({
    where: { AND: filters },
    include: videoInclude,
    orderBy: popular ? [{ viewsCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] : [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
  });
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: await decorateVideos(ctx, page, viewerId),
    nextCursor: rows.length > query.limit && last ? encodeCursor({ ...(popular ? { v: last.viewsCount } : {}), t: last.createdAt.toISOString(), id: last.id }) : null,
  };
}

/** Public video detail; owners and admins may also see unpublished videos. */
export async function getVideo(ctx: AppContext, id: string, viewer?: { id: string; role: string }): Promise<VideoDto> {
  const video = await ctx.prisma.video.findUnique({ where: { id }, include: { ...videoInclude, creator: { select: { ...videoInclude.creator.select, userId: true } } } });
  if (!video || video.archivedAt) throw notFound('Video not found');
  const isOwner = viewer && video.creator.userId === viewer.id;
  const isPublic = video.isPublished && video.processingStatus === 'COMPLETED';
  if (!isPublic && !isOwner && viewer?.role !== 'ADMIN') throw notFound('Video not found');
  return (await decorateVideos(ctx, [video], viewer?.id))[0] as VideoDto;
}

export async function getThumbnailPath(ctx: AppContext, id: string): Promise<string> {
  const video = await ctx.prisma.video.findUnique({ where: { id }, select: { thumbnailPath: true, archivedAt: true } });
  if (!video?.thumbnailPath || video.archivedAt || !fs.existsSync(video.thumbnailPath)) throw notFound('Thumbnail not found');
  return video.thumbnailPath;
}

export async function listCategories(ctx: AppContext): Promise<Array<{ name: string; count: number }>> {
  const rows = await ctx.prisma.video.groupBy({ by: ['category'], where: publicVideoWhere, _count: { _all: true } });
  const counts = new Map(rows.map((r) => [r.category, r._count._all]));
  const names = Array.from(new Set<string>([...CATEGORIES, ...counts.keys()]));
  return names.map((name) => ({ name, count: counts.get(name) ?? 0 }));
}

export async function getCreatorProfile(ctx: AppContext, id: string): Promise<CreatorProfileDto> {
  const creator = await ctx.prisma.creatorProfile.findUnique({ where: { id }, include: { user: { select: { username: true } } } });
  if (!creator) throw notFound('Creator not found');
  const agg = await ctx.prisma.video.aggregate({ where: { creatorId: id, ...publicVideoWhere }, _count: { _all: true }, _sum: { viewsCount: true } });
  return {
    id: creator.id,
    username: creator.user.username,
    channelName: creator.channelName,
    bio: creator.bio,
    videoCount: agg._count._all,
    totalViews: agg._sum.viewsCount ?? 0,
    createdAt: creator.createdAt.toISOString(),
  };
}
