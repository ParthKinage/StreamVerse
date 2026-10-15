import { CATEGORIES, type CreatorProfileDto, type VideoDto, type VideoListQuery, type VideoListResponse } from '@tesor_gp/shared';
import type { Prisma } from '@tesor_gp/database';
import type { AppContext } from '../../context';
import { Memo } from '../../middleware/http-cache';
import { notFound } from '../../middleware/errors';
import { decodeCursor, encodeCursor, videoInclude, videoToDto, type VideoWithCreator } from '../common';

export const publicVideoWhere: Prisma.VideoWhereInput = { isPublished: true, processingStatus: 'COMPLETED', archivedAt: null };
/** A live stream that is on air now: watchable although its video is not in the catalog yet. */
export const liveNowWhere: Prisma.VideoWhereInput = { archivedAt: null, liveStream: { is: { status: 'LIVE' } } };
/** Everything a viewer may start watching. */
export const watchableVideoWhere: Prisma.VideoWhereInput = { OR: [publicVideoWhere, liveNowWhere] };

/** Adds per-user flags (liked, in watchlist) and like counts to a page of videos. */
export async function decorateVideos(ctx: AppContext, videos: VideoWithCreator[], viewerId?: string): Promise<VideoDto[]> {
  if (videos.length === 0) return [];
  const ids = videos.map((v) => v.id);
  const sold = videos.filter((v) => v.accessPriceSTRM !== null).map((v) => v.id);
  const [likeCounts, liked, watch, paid, bought] = await Promise.all([
    ctx.prisma.videoLike.groupBy({ by: ['videoId'], where: { videoId: { in: ids } }, _count: { _all: true } }),
    viewerId ? ctx.prisma.videoLike.findMany({ where: { userId: viewerId, videoId: { in: ids } }, select: { videoId: true } }) : Promise.resolve([]),
    viewerId ? ctx.prisma.watchlistItem.findMany({ where: { userId: viewerId, videoId: { in: ids } }, select: { videoId: true } }) : Promise.resolve([]),
    viewerId
      ? ctx.prisma.paidSegment.groupBy({ by: ['videoId'], where: { userId: viewerId, videoId: { in: ids } }, _sum: { durationMs: true } })
      : Promise.resolve([]),
    viewerId && sold.length
      ? ctx.prisma.videoPurchase.findMany({ where: { userId: viewerId, videoId: { in: sold }, expiresAt: { gt: ctx.now() } }, select: { videoId: true } })
      : Promise.resolve([]),
  ]);
  const boughtSet = new Set(bought.map((b) => b.videoId));
  const counts = new Map(likeCounts.map((c) => [c.videoId, c._count._all]));
  const likedSet = new Set(liked.map((l) => l.videoId));
  const watchSet = new Set(watch.map((w) => w.videoId));
  const paidSeconds = new Map(paid.map((p) => [p.videoId, Math.floor((p._sum.durationMs ?? 0) / 1000)]));
  return videos.map((v) =>
    videoToDto(v, {
      likesCount: counts.get(v.id) ?? 0,
      ...(viewerId
        ? {
            liked: likedSet.has(v.id),
            inWatchlist: watchSet.has(v.id),
            paidSeconds: paidSeconds.get(v.id) ?? 0,
            hasAccess: v.accessPriceSTRM === null || boughtSet.has(v.id) || v.accessPriceSTRM.isZero(),
          }
        : {}),
    }),
  );
}

/** No charge of any kind: no rate per minute and no access price (or a zero one). */
const freeWhere: Prisma.VideoWhereInput = { ratePerMinuteSTRM: 0, OR: [{ accessPriceSTRM: null }, { accessPriceSTRM: 0 }] };

const LENGTH_WHERE: Record<NonNullable<VideoListQuery['length']>, Prisma.VideoWhereInput> = {
  short: { durationSeconds: { lt: 240 } },
  medium: { durationSeconds: { gte: 240, lte: 1200 } },
  long: { durationSeconds: { gt: 1200 } },
};

/**
 * Videos the viewer owns: live streams and recordings they bought, and videos whose every second they have paid for
 * (those play free from then on). Free videos are never "owned"; there is nothing to own.
 */
export async function ownedVideoIds(ctx: AppContext, userId: string): Promise<string[]> {
  const [bought, paid] = await Promise.all([
    ctx.prisma.videoPurchase.findMany({ where: { userId, expiresAt: { gt: ctx.now() }, amountSTRM: { gt: 0 } }, select: { videoId: true }, distinct: ['videoId'] }),
    ctx.prisma.paidSegment.groupBy({ by: ['videoId'], where: { userId }, _sum: { durationMs: true } }),
  ]);
  const ids = new Set(bought.map((b) => b.videoId));
  const candidates = paid.filter((p) => !ids.has(p.videoId));
  if (candidates.length) {
    const lengths = await ctx.prisma.video.findMany({ where: { id: { in: candidates.map((p) => p.videoId) }, durationSeconds: { gt: 0 } }, select: { id: true, durationSeconds: true } });
    const seconds = new Map(lengths.map((v) => [v.id, v.durationSeconds]));
    for (const p of candidates) {
      const length = seconds.get(p.videoId);
      // Pieces are about 4 s; a second of slack covers rounding in the last one.
      if (length && (p._sum.durationMs ?? 0) >= length * 1000 - 1000) ids.add(p.videoId);
    }
  }
  return [...ids];
}

const TRENDING_WINDOW = 500;

/** Video ids ordered by completed views in the last 7 days, then newest. Used by sort=trending and as AI fallback. */
export async function trendingVideoIds(ctx: AppContext, limit: number, offset = 0, excludeId?: string): Promise<string[]> {
  const since = new Date(ctx.now().getTime() - 7 * 86_400_000);
  // Both queries run at once (one database round trip instead of two); the second takes enough rows to cover any overlap.
  const [recent, rest] = await Promise.all([
    ctx.prisma.watchSession.groupBy({
      by: ['videoId'],
      where: { viewCounted: true, startedAt: { gte: since }, video: publicVideoWhere },
      _count: { _all: true },
      orderBy: { _count: { videoId: 'desc' } },
      take: TRENDING_WINDOW,
    }),
    ctx.prisma.video.findMany({
      where: { ...publicVideoWhere, ...(excludeId ? { id: { not: excludeId } } : {}) },
      orderBy: [{ viewsCount: 'desc' }, { createdAt: 'desc' }],
      take: offset + limit + TRENDING_WINDOW,
      select: { id: true },
    }),
  ]);
  const ranked = recent.map((r) => r.videoId).filter((id) => id !== excludeId);
  const seen = new Set(ranked);
  return [...ranked, ...rest.map((r) => r.id).filter((id) => !seen.has(id))].slice(offset, offset + limit);
}

export async function listVideos(ctx: AppContext, query: VideoListQuery, viewerId?: string, extra?: Prisma.VideoWhereInput): Promise<VideoListResponse> {
  const filters: Prisma.VideoWhereInput[] = [publicVideoWhere];
  if (extra) filters.push(extra);
  if (query.category) filters.push({ category: query.category });
  if (query.creatorId) filters.push({ creatorId: query.creatorId });
  if (query.price === 'free') filters.push(freeWhere);
  if (query.price === 'paid') filters.push({ NOT: freeWhere });
  if (query.length) filters.push(LENGTH_WHERE[query.length]);
  if (query.owned && viewerId) filters.push({ id: { in: await ownedVideoIds(ctx, viewerId) } });
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
  const isPublic = (video.isPublished && video.processingStatus === 'COMPLETED') || video.liveStream?.status === 'LIVE';
  if (!isPublic && !isOwner && viewer?.role !== 'ADMIN') throw notFound('Video not found');
  const dto = (await decorateVideos(ctx, [video], viewer?.id))[0] as VideoDto;
  if (dto.live?.status === 'LIVE') {
    const since = new Date(ctx.now().getTime() - ctx.env.SESSION_TIMEOUT_SEC * 1000);
    dto.live.viewers = await ctx.prisma.watchSession.count({ where: { videoId: id, status: 'ACTIVE', lastHeartbeatAt: { gte: since } } });
  }
  return dto;
}

export async function getThumbnailPath(ctx: AppContext, id: string): Promise<string> {
  const video = await ctx.prisma.video.findUnique({ where: { id }, select: { thumbnailPath: true, archivedAt: true } });
  if (!video?.thumbnailPath || video.archivedAt || !(await ctx.storage.exists(video.thumbnailPath))) throw notFound('Thumbnail not found');
  return video.thumbnailPath;
}

const categoriesMemo = new WeakMap<AppContext, Memo<Array<{ name: string; count: number }>>>();

/** Categories with video counts; computed at most every 30 s per API instance. */
export async function listCategories(ctx: AppContext): Promise<Array<{ name: string; count: number }>> {
  let memo = categoriesMemo.get(ctx);
  if (!memo) categoriesMemo.set(ctx, (memo = new Memo(30_000)));
  return memo.get(async () => {
    const rows = await ctx.prisma.video.groupBy({ by: ['category'], where: publicVideoWhere, _count: { _all: true } });
    const counts = new Map(rows.map((r) => [r.category, r._count._all]));
    const names = Array.from(new Set<string>([...CATEGORIES, ...counts.keys()]));
    return names.map((name) => ({ name, count: counts.get(name) ?? 0 }));
  });
}

type CreatorRow = Prisma.CreatorProfileGetPayload<{ include: { user: { select: { username: true } } } }>;

/** Channel cards with counts (and, for a signed-in viewer, whether they follow each one). */
export async function creatorsToDto(ctx: AppContext, creators: CreatorRow[], viewerId?: string): Promise<CreatorProfileDto[]> {
  if (creators.length === 0) return [];
  const ids = creators.map((c) => c.id);
  const [videos, followers, mine] = await Promise.all([
    ctx.prisma.video.groupBy({ by: ['creatorId'], where: { creatorId: { in: ids }, ...publicVideoWhere }, _count: { _all: true }, _sum: { viewsCount: true } }),
    ctx.prisma.follow.groupBy({ by: ['creatorId'], where: { creatorId: { in: ids } }, _count: { _all: true } }),
    viewerId ? ctx.prisma.follow.findMany({ where: { followerId: viewerId, creatorId: { in: ids } }, select: { creatorId: true } }) : Promise.resolve([]),
  ]);
  const videoAgg = new Map(videos.map((v) => [v.creatorId, v]));
  const followerCount = new Map(followers.map((f) => [f.creatorId, f._count._all]));
  const followed = new Set(mine.map((m) => m.creatorId));
  return creators.map((c) => ({
    id: c.id,
    username: c.user.username,
    channelName: c.channelName,
    bio: c.bio,
    videoCount: videoAgg.get(c.id)?._count._all ?? 0,
    totalViews: videoAgg.get(c.id)?._sum.viewsCount ?? 0,
    followersCount: followerCount.get(c.id) ?? 0,
    ...(viewerId ? { following: followed.has(c.id) } : {}),
    createdAt: c.createdAt.toISOString(),
  }));
}

export async function getCreatorProfile(ctx: AppContext, id: string, viewerId?: string): Promise<CreatorProfileDto> {
  const creator = await ctx.prisma.creatorProfile.findUnique({ where: { id }, include: { user: { select: { username: true } } } });
  if (!creator) throw notFound('Creator not found');
  return (await creatorsToDto(ctx, [creator], viewerId))[0] as CreatorProfileDto;
}

/** Channels whose name or username matches the search; the most followed first. */
export async function searchCreators(ctx: AppContext, q: string, viewerId?: string, limit = 6): Promise<CreatorProfileDto[]> {
  const rows = await ctx.prisma.creatorProfile.findMany({
    where: { OR: [{ channelName: { contains: q, mode: 'insensitive' } }, { user: { username: { contains: q, mode: 'insensitive' } } }] },
    include: { user: { select: { username: true } } },
    take: 50,
  });
  const dtos = await creatorsToDto(ctx, rows, viewerId);
  return dtos.sort((a, b) => b.followersCount - a.followersCount || b.videoCount - a.videoCount || a.channelName.localeCompare(b.channelName)).slice(0, limit);
}
