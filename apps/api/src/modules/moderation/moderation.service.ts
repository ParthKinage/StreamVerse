import { weiToString, type AdminOverview, type AdminReportItem, type CreateReportRequest, type ResolveReportRequest } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { forgetSuspension } from '../../middleware/auth';
import { badRequest, notFound } from '../../middleware/errors';
import { toWei } from '../common';
import { endStream } from '../live';

const QUEUE_LIMIT = 2000;
const DETAILS_SHOWN = 3;

function messageId(targetId: string): number {
  const id = Number(targetId);
  if (!Number.isInteger(id) || id < 1) throw badRequest('VALIDATION_ERROR', 'Unknown message');
  return id;
}

/** A viewer reports a video, a chat message or a channel. Reporting the same thing again updates the earlier report. */
export async function createReport(ctx: AppContext, reporterId: string, input: CreateReportRequest): Promise<{ reported: true }> {
  if (input.targetType === 'VIDEO') {
    const v = await ctx.prisma.video.findUnique({ where: { id: input.targetId }, select: { archivedAt: true } });
    if (!v || v.archivedAt) throw notFound('Video not found');
  } else if (input.targetType === 'CHAT_MESSAGE') {
    const m = await ctx.prisma.liveChatMessage.findUnique({ where: { id: messageId(input.targetId) }, select: { id: true } });
    if (!m) throw notFound('Message not found');
  } else {
    const c = await ctx.prisma.creatorProfile.findUnique({ where: { id: input.targetId }, select: { id: true } });
    if (!c) throw notFound('Channel not found');
  }
  const key = { reporterId_targetType_targetId: { reporterId, targetType: input.targetType, targetId: input.targetId } };
  const data = { reason: input.reason, details: input.details || null, status: 'OPEN' as const, createdAt: ctx.now(), resolvedAt: null, resolvedById: null };
  await ctx.prisma.report.upsert({ where: key, update: data, create: { reporterId, targetType: input.targetType, targetId: input.targetId, ...data } });
  return { reported: true };
}

/** Open (or past) reports, grouped per reported item, most reported first. */
export async function listReports(ctx: AppContext, status: 'OPEN' | 'DISMISSED' | 'ACTIONED' = 'OPEN'): Promise<{ items: AdminReportItem[] }> {
  const rows = await ctx.prisma.report.findMany({ where: { status }, orderBy: { createdAt: 'desc' }, take: QUEUE_LIMIT });
  const groups = new Map<string, { targetType: AdminReportItem['targetType']; targetId: string; count: number; reasons: Record<string, number>; details: string[]; latestAt: Date }>();
  for (const r of rows) {
    const k = `${r.targetType}:${r.targetId}`;
    const g = groups.get(k) ?? { targetType: r.targetType, targetId: r.targetId, count: 0, reasons: {}, details: [], latestAt: r.createdAt };
    g.count++;
    g.reasons[r.reason] = (g.reasons[r.reason] ?? 0) + 1;
    if (r.details && g.details.length < DETAILS_SHOWN) g.details.push(r.details);
    groups.set(k, g);
  }
  const list = Array.from(groups.values());
  const ids = (t: string) => list.filter((g) => g.targetType === t).map((g) => g.targetId);
  const [videos, messages, channels] = await Promise.all([
    ctx.prisma.video.findMany({
      where: { id: { in: ids('VIDEO') } },
      select: { id: true, title: true, hiddenAt: true, creator: { select: { userId: true, user: { select: { username: true, suspendedAt: true } } } } },
    }),
    ctx.prisma.liveChatMessage.findMany({
      where: { id: { in: ids('CHAT_MESSAGE').map(Number).filter((n) => Number.isInteger(n)) } },
      select: { id: true, text: true, removedAt: true, userId: true, user: { select: { username: true, suspendedAt: true } }, liveStream: { select: { videoId: true } } },
    }),
    ctx.prisma.creatorProfile.findMany({ where: { id: { in: ids('CHANNEL') } }, select: { id: true, channelName: true, userId: true, user: { select: { username: true, suspendedAt: true } } } }),
  ]);
  const vById = new Map(videos.map((v) => [v.id, v]));
  const mById = new Map(messages.map((m) => [String(m.id), m]));
  const cById = new Map(channels.map((c) => [c.id, c]));

  const items: AdminReportItem[] = list.map((g) => {
    let target: AdminReportItem['target'] = { label: '(no longer exists)', ownerUserId: null, ownerUsername: null, videoId: null, state: 'deleted' };
    if (g.targetType === 'VIDEO') {
      const v = vById.get(g.targetId);
      if (v) {
        target = {
          label: v.title,
          ownerUserId: v.creator.userId,
          ownerUsername: v.creator.user.username,
          videoId: v.id,
          state: v.hiddenAt ? 'hidden' : v.creator.user.suspendedAt ? 'owner suspended' : null,
        };
      }
    } else if (g.targetType === 'CHAT_MESSAGE') {
      const m = mById.get(g.targetId);
      if (m) {
        target = {
          label: m.text || '(tip without a message)',
          ownerUserId: m.userId,
          ownerUsername: m.user.username,
          videoId: m.liveStream.videoId,
          state: m.removedAt ? 'removed' : m.user.suspendedAt ? 'owner suspended' : null,
        };
      }
    } else {
      const c = cById.get(g.targetId);
      if (c) target = { label: c.channelName, ownerUserId: c.userId, ownerUsername: c.user.username, videoId: null, state: c.user.suspendedAt ? 'suspended' : null };
    }
    return { targetType: g.targetType, targetId: g.targetId, count: g.count, reasons: g.reasons, details: g.details, latestAt: g.latestAt.toISOString(), target };
  });
  items.sort((a, b) => b.count - a.count || b.latestAt.localeCompare(a.latestAt));
  return { items };
}

/** Hides a video from everyone but its creator and admins; a live stream on it is ended. */
export async function hideVideo(ctx: AppContext, videoId: string, reason?: string): Promise<void> {
  const v = await ctx.prisma.video.findUnique({ where: { id: videoId }, select: { id: true, liveStream: { select: { id: true, status: true } } } });
  if (!v) throw notFound('Video not found');
  await ctx.prisma.video.update({ where: { id: videoId }, data: { hiddenAt: ctx.now(), hiddenReason: reason || null } });
  if (v.liveStream && (v.liveStream.status === 'LIVE' || v.liveStream.status === 'STARTING')) await endStream(ctx, v.liveStream.id, 'ENDED_BY_ADMIN');
}

export async function unhideVideo(ctx: AppContext, videoId: string): Promise<void> {
  const updated = await ctx.prisma.video.updateMany({ where: { id: videoId }, data: { hiddenAt: null, hiddenReason: null } });
  if (!updated.count) throw notFound('Video not found');
}

/** Suspends an account: no sign-in, every session signed out, any live stream ended. Admins cannot be suspended. */
export async function suspendUser(ctx: AppContext, adminId: string, userId: string, reason?: string): Promise<void> {
  const u = await ctx.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, creatorProfile: { select: { id: true } } } });
  if (!u) throw notFound('User not found');
  if (u.id === adminId || u.role === 'ADMIN') throw badRequest('VALIDATION_ERROR', 'Admins cannot be suspended');
  await ctx.prisma.$transaction([
    ctx.prisma.user.update({ where: { id: userId }, data: { suspendedAt: ctx.now(), suspendReason: reason || null } }),
    ctx.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: ctx.now() } }),
  ]);
  forgetSuspension(userId);
  if (u.creatorProfile) {
    const live = await ctx.prisma.liveStream.findMany({ where: { creatorId: u.creatorProfile.id, status: { in: ['STARTING', 'LIVE'] } }, select: { id: true } });
    for (const s of live) await endStream(ctx, s.id, 'ENDED_BY_ADMIN');
  }
}

export async function unsuspendUser(ctx: AppContext, userId: string): Promise<void> {
  const updated = await ctx.prisma.user.updateMany({ where: { id: userId }, data: { suspendedAt: null, suspendReason: null } });
  if (!updated.count) throw notFound('User not found');
  forgetSuspension(userId);
}

async function ownerOf(ctx: AppContext, targetType: ResolveReportRequest['targetType'], targetId: string): Promise<string> {
  if (targetType === 'VIDEO') {
    const v = await ctx.prisma.video.findUnique({ where: { id: targetId }, select: { creator: { select: { userId: true } } } });
    if (!v) throw notFound('Video not found');
    return v.creator.userId;
  }
  if (targetType === 'CHAT_MESSAGE') {
    const m = await ctx.prisma.liveChatMessage.findUnique({ where: { id: messageId(targetId) }, select: { userId: true } });
    if (!m) throw notFound('Message not found');
    return m.userId;
  }
  const c = await ctx.prisma.creatorProfile.findUnique({ where: { id: targetId }, select: { userId: true } });
  if (!c) throw notFound('Channel not found');
  return c.userId;
}

/** An admin decides on a reported item: dismiss the reports, or act (hide, remove, suspend) and close them. */
export async function resolveReports(ctx: AppContext, adminId: string, input: ResolveReportRequest): Promise<{ resolved: number }> {
  const { targetType, targetId, action, reason } = input;
  if (action === 'hide_video') {
    if (targetType !== 'VIDEO') throw badRequest('VALIDATION_ERROR', 'Only videos can be hidden');
    await hideVideo(ctx, targetId, reason);
  } else if (action === 'remove_message') {
    if (targetType !== 'CHAT_MESSAGE') throw badRequest('VALIDATION_ERROR', 'Only chat messages can be removed');
    const updated = await ctx.prisma.liveChatMessage.updateMany({ where: { id: messageId(targetId), removedAt: null }, data: { removedAt: ctx.now() } });
    if (!updated.count && !(await ctx.prisma.liveChatMessage.findUnique({ where: { id: messageId(targetId) }, select: { id: true } }))) throw notFound('Message not found');
  } else if (action === 'suspend_owner') {
    await suspendUser(ctx, adminId, await ownerOf(ctx, targetType, targetId), reason);
  }
  const done = await ctx.prisma.report.updateMany({
    where: { targetType, targetId, status: 'OPEN' },
    data: { status: action === 'dismiss' ? 'DISMISSED' : 'ACTIONED', resolvedAt: ctx.now(), resolvedById: adminId },
  });
  return { resolved: done.count };
}

export async function overview(ctx: AppContext): Promise<AdminOverview> {
  const now = ctx.now();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [open, newUsers, tips, suspended, hidden] = await Promise.all([
    ctx.prisma.report.groupBy({ by: ['targetType', 'targetId'], where: { status: 'OPEN' } }),
    ctx.prisma.user.count({ where: { createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } } }),
    ctx.prisma.tip.aggregate({ where: { createdAt: { gte: midnight } }, _sum: { amountSTRM: true } }),
    ctx.prisma.user.count({ where: { suspendedAt: { not: null } } }),
    ctx.prisma.video.count({ where: { hiddenAt: { not: null }, archivedAt: null } }),
  ]);
  return {
    openReports: open.length,
    newUsers7d: newUsers,
    tipsTodayWei: weiToString(tips._sum.amountSTRM ? toWei(tips._sum.amountSTRM) : 0n),
    suspendedUsers: suspended,
    hiddenVideos: hidden,
  };
}
