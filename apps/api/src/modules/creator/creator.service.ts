import {
  DEFAULT_VIDEO_PRICE_STRM,
  DOMAIN_EVENTS,
  MAX_VIDEO_PRICE_STRM,
  parseSTRM,
  stringToWei,
  weiToString,
  type CreatorAnalytics,
  type CreatorEarnings,
  type UpdateVideoRequest,
  type UserDto,
  type VideoDto,
} from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../middleware/errors';
import { decodeCursor, encodeCursor, fromWei, toWei, userToDto, videoInclude, videoToDto } from '../common';
import { decorateVideos } from '../catalog';
import { enqueueTranscode } from '../media';
import { isPayoutPending } from '../managed/payout';
import { isManaged } from '../managed/wallets';
import { claimableFor, getLifetimeEarned, getPaidOut } from './earnings';

const MAX_PRICE_WEI = parseSTRM(String(MAX_VIDEO_PRICE_STRM));

export function validatePriceWei(raw: string | undefined): bigint {
  if (raw === undefined) return parseSTRM(DEFAULT_VIDEO_PRICE_STRM);
  const wei = stringToWei(raw);
  if (wei > MAX_PRICE_WEI) throw badRequest('VALIDATION_ERROR', `Price must be between 0 and ${MAX_VIDEO_PRICE_STRM} for the whole video`);
  return wei;
}

export async function becomeCreator(ctx: AppContext, userId: string, input: { channelName: string; bio?: string | undefined }): Promise<{ user: UserDto; created: boolean }> {
  const existing = await ctx.prisma.creatorProfile.findUnique({ where: { userId } });
  if (existing) {
    await ctx.prisma.creatorProfile.update({ where: { userId }, data: { channelName: input.channelName, bio: input.bio ?? null } });
  } else {
    await ctx.prisma.creatorProfile.create({ data: { userId, channelName: input.channelName, bio: input.bio ?? null } });
  }
  const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const updated = user.role === 'USER' ? await ctx.prisma.user.update({ where: { id: userId }, data: { role: 'CREATOR' } }) : user;
  return { user: userToDto({ ...updated, creatorProfile: { channelName: input.channelName } }), created: !existing };
}

export async function requireCreatorProfile(ctx: AppContext, userId: string): Promise<{ id: string }> {
  const profile = await ctx.prisma.creatorProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!profile) throw forbidden('Create a creator profile first', 'NOT_CREATOR');
  return profile;
}

async function ownedVideo(ctx: AppContext, userId: string, videoId: string) {
  const profile = await requireCreatorProfile(ctx, userId);
  const video = await ctx.prisma.video.findFirst({ where: { id: videoId, creatorId: profile.id, archivedAt: null }, include: videoInclude });
  if (!video) throw notFound('Video not found');
  return video;
}

export async function createVideo(
  ctx: AppContext,
  userId: string,
  input: { title: string; description: string; category: string; tags: string[]; priceWei?: string | undefined },
  filePath: string,
): Promise<VideoDto> {
  const profile = await requireCreatorProfile(ctx, userId);
  const price = validatePriceWei(input.priceWei);
  const video = await ctx.prisma.video.create({
    data: {
      title: input.title,
      description: input.description,
      category: input.category,
      tags: input.tags,
      creatorId: profile.id,
      originalFilePath: filePath,
      priceSTRM: fromWei(price),
    },
    include: videoInclude,
  });
  await enqueueTranscode(ctx, video.id, filePath);
  ctx.events.emit(DOMAIN_EVENTS.VIDEO_UPLOADED, { videoId: video.id });
  return videoToDto(video);
}

/** The video (if any) this creator already made from an uploaded original; makes direct-upload completion idempotent. */
export async function findVideoByOriginal(ctx: AppContext, userId: string, originalFilePath: string): Promise<VideoDto | undefined> {
  const profile = await requireCreatorProfile(ctx, userId);
  const video = await ctx.prisma.video.findFirst({ where: { creatorId: profile.id, originalFilePath, archivedAt: null }, include: videoInclude });
  return video ? videoToDto(video) : undefined;
}

export async function listOwnVideos(ctx: AppContext, userId: string, cursor: string | undefined, limit: number) {
  const profile = await requireCreatorProfile(ctx, userId);
  const cur = decodeCursor<{ t: string; id: string }>(cursor);
  const rows = await ctx.prisma.video.findMany({
    where: {
      creatorId: profile.id,
      archivedAt: null,
      ...(cur ? { OR: [{ createdAt: { lt: new Date(cur.t) } }, { createdAt: new Date(cur.t), id: { lt: cur.id } }] } : {}),
    },
    include: videoInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: await decorateVideos(ctx, page, userId),
    nextCursor: rows.length > limit && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
  };
}

export async function updateVideo(ctx: AppContext, userId: string, videoId: string, patch: UpdateVideoRequest): Promise<VideoDto> {
  await ownedVideo(ctx, userId, videoId);
  const updated = await ctx.prisma.video.update({
    where: { id: videoId },
    data: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.priceWei !== undefined ? { priceSTRM: fromWei(validatePriceWei(patch.priceWei)) } : {}),
    },
    include: videoInclude,
  });
  return videoToDto(updated);
}

export async function setPublished(ctx: AppContext, userId: string, videoId: string, published: boolean): Promise<VideoDto> {
  const video = await ownedVideo(ctx, userId, videoId);
  if (published && video.processingStatus !== 'COMPLETED') {
    throw conflict('VIDEO_NOT_AVAILABLE', 'The video can be published once transcoding has completed');
  }
  const updated = await ctx.prisma.video.update({ where: { id: videoId }, data: { isPublished: published }, include: videoInclude });
  if (published) ctx.events.emit(DOMAIN_EVENTS.VIDEO_PUBLISHED, { videoId });
  return videoToDto(updated);
}

export async function retryTranscode(ctx: AppContext, userId: string, videoId: string): Promise<VideoDto> {
  const video = await ownedVideo(ctx, userId, videoId);
  if (video.processingStatus !== 'FAILED') throw conflict('CONFLICT', 'Only failed videos can be retried');
  const updated = await ctx.prisma.video.update({
    where: { id: videoId },
    data: { processingStatus: 'PENDING', transcodeProgress: 0, failureReason: null },
    include: videoInclude,
  });
  await enqueueTranscode(ctx, videoId, video.originalFilePath);
  return videoToDto(updated);
}

/** "Delete" archives the video: unpublished, hidden everywhere, files removed. Billing history keeps its references. */
export async function archiveVideo(ctx: AppContext, userId: string, videoId: string): Promise<void> {
  const video = await ownedVideo(ctx, userId, videoId);
  await ctx.prisma.video.update({ where: { id: videoId }, data: { isPublished: false, archivedAt: ctx.now() } });
  await ctx.storage.deleteVideoMedia(video.id).catch(() => undefined);
  await ctx.storage.deleteFile(video.originalFilePath).catch(() => undefined);
}

export async function getEarnings(ctx: AppContext, userId: string): Promise<CreatorEarnings> {
  const profile = await requireCreatorProfile(ctx, userId);
  const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { walletAddress: true } });
  const claimable = await claimableFor(ctx, userId, profile.id, user.walletAddress);
  const pending = await ctx.prisma.paymentSettlement.aggregate({
    where: { creatorId: profile.id, escrowAppliedAt: null, status: { in: ['PENDING', 'SETTLED'] } },
    _sum: { creatorEarningsSTRM: true },
  });
  const managed = isManaged(ctx);
  return {
    claimableWei: weiToString(claimable),
    lifetimeEarnedWei: weiToString(await getLifetimeEarned(ctx, profile.id)),
    pendingSettlementWei: weiToString(pending._sum.creatorEarningsSTRM ? toWei(pending._sum.creatorEarningsSTRM) : 0n),
    paidOutWei: weiToString(ctx.env.PAYMENTS_MODE === 'chain' && user.walletAddress ? await getPaidOut(ctx, user.walletAddress) : 0n),
    payoutPending: managed ? await isPayoutPending(ctx, userId) : false,
  };
}

export async function getAnalytics(ctx: AppContext, userId: string): Promise<CreatorAnalytics> {
  const profile = await requireCreatorProfile(ctx, userId);
  const videos = await ctx.prisma.video.findMany({ where: { creatorId: profile.id, archivedAt: null }, select: { id: true, title: true, viewsCount: true } });
  const ids = videos.map((v) => v.id);
  const [watch, earned, daily] = await Promise.all([
    ctx.prisma.watchSession.groupBy({ by: ['videoId'], where: { videoId: { in: ids } }, _sum: { verifiedDurationSeconds: true } }),
    ctx.prisma.paymentSettlement.groupBy({ by: ['videoId'], where: { videoId: { in: ids }, status: 'SETTLED' }, _sum: { creatorEarningsSTRM: true } }),
    ctx.prisma.$queryRaw<Array<{ day: Date; views: bigint; seconds: bigint | null; earnings: string | null }>>`
      WITH w AS (
        SELECT date_trunc('day', s."startedAt") AS day,
               COUNT(*) FILTER (WHERE s."viewCounted") AS views,
               SUM(s."verifiedDurationSeconds") AS seconds
        FROM "WatchSession" s JOIN "Video" v ON v.id = s."videoId"
        WHERE v."creatorId" = ${profile.id} AND s."startedAt" >= now() - interval '30 days'
        GROUP BY 1
      ), e AS (
        SELECT date_trunc('day', p."createdAt") AS day, SUM(p."creatorEarningsSTRM")::text AS earnings
        FROM "PaymentSettlement" p
        WHERE p."creatorId" = ${profile.id} AND p."status" = 'SETTLED' AND p."createdAt" >= now() - interval '30 days'
        GROUP BY 1
      )
      SELECT w.day, w.views, w.seconds, e.earnings FROM w LEFT JOIN e ON e.day = w.day ORDER BY w.day ASC`,
  ]);
  const watchBy = new Map(watch.map((w) => [w.videoId, w._sum.verifiedDurationSeconds ?? 0]));
  const earnedBy = new Map(earned.map((e) => [e.videoId, e._sum.creatorEarningsSTRM ? toWei(e._sum.creatorEarningsSTRM) : 0n]));
  const rows = videos.map((v) => ({
    videoId: v.id,
    title: v.title,
    views: v.viewsCount,
    watchSeconds: watchBy.get(v.id) ?? 0,
    earningsWei: weiToString(earnedBy.get(v.id) ?? 0n),
  }));
  return {
    totalViews: rows.reduce((a, r) => a + r.views, 0),
    totalWatchSeconds: rows.reduce((a, r) => a + r.watchSeconds, 0),
    totalEarningsWei: weiToString(rows.reduce((a, r) => a + BigInt(r.earningsWei), 0n)),
    videos: rows,
    daily: daily.map((d) => ({
      date: d.day.toISOString().slice(0, 10),
      views: Number(d.views),
      watchSeconds: Number(d.seconds ?? 0n),
      earningsWei: weiToString(d.earnings ? toWei(d.earnings) : 0n),
    })),
  };
}

export { AppError };
