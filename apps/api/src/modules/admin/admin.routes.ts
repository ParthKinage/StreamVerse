import { Router } from 'express';
import { z } from 'zod';
import { cursorQuery, type AdminSettlementDto } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { requireAuth, requireRole } from '../../middleware/auth';
import { notFound } from '../../middleware/errors';
import { validate } from '../../middleware/validate';
import { decodeCursor, encodeCursor, toWei, userToDto, videoInclude, videoToDto } from '../common';
import { getRevenue } from '../managed/revenue';
import { retrySettlement } from '../settlement';
import { collectHealth } from '../ops';

const listQuery = cursorQuery.extend({ q: z.string().trim().max(100).optional(), status: z.string().optional() });

export function adminRoutes(ctx: AppContext): Router {
  const router = Router();
  const guard = [requireAuth(ctx), requireRole(ctx, 'ADMIN')];

  router.get('/admin/users', ...guard, validate('query', listQuery), async (req, res) => {
    const q = req.query as unknown as { cursor?: string; limit: number; q?: string };
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor);
    const rows = await ctx.prisma.user.findMany({
      where: {
        ...(q.q ? { OR: [{ email: { contains: q.q, mode: 'insensitive' } }, { username: { contains: q.q, mode: 'insensitive' } }] } : {}),
        ...(cur ? { OR: [{ createdAt: { lt: new Date(cur.t) } }, { createdAt: new Date(cur.t), id: { lt: cur.id } }] } : {}),
      },
      include: { creatorProfile: { select: { channelName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    res.json({ items: page.map(userToDto), nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null });
  });

  router.get('/admin/videos', ...guard, validate('query', listQuery), async (req, res) => {
    const q = req.query as unknown as { cursor?: string; limit: number; q?: string; status?: string };
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor);
    const rows = await ctx.prisma.video.findMany({
      where: {
        archivedAt: null,
        ...(q.status && ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'].includes(q.status) ? { processingStatus: q.status as 'PENDING' } : {}),
        ...(q.q ? { title: { contains: q.q, mode: 'insensitive' } } : {}),
        ...(cur ? { OR: [{ createdAt: { lt: new Date(cur.t) } }, { createdAt: new Date(cur.t), id: { lt: cur.id } }] } : {}),
      },
      include: videoInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    res.json({ items: page.map((v) => videoToDto(v)), nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null });
  });

  router.post('/admin/videos/:id/unpublish', ...guard, async (req, res) => {
    const id = String(req.params.id);
    const found = await ctx.prisma.video.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw notFound('Video not found');
    const video = await ctx.prisma.video.update({ where: { id }, data: { isPublished: false }, include: videoInclude });
    res.json(videoToDto(video));
  });

  router.get('/admin/settlements', ...guard, validate('query', listQuery), async (req, res) => {
    const q = req.query as unknown as { cursor?: string; limit: number; status?: string };
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor);
    const rows = await ctx.prisma.paymentSettlement.findMany({
      where: {
        ...(q.status && ['PENDING', 'SETTLED', 'FAILED'].includes(q.status) ? { status: q.status as 'PENDING' } : {}),
        ...(cur ? { OR: [{ createdAt: { lt: new Date(cur.t) } }, { createdAt: new Date(cur.t), id: { lt: cur.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const items: AdminSettlementDto[] = page.map((s) => ({
      id: s.id,
      sessionId: s.sessionId,
      userId: s.userId,
      amountWei: toWei(s.amountSTRM).toString(),
      status: s.status,
      attempts: s.attempts,
      lastError: s.lastError,
      txHash: s.txHash,
      createdAt: s.createdAt.toISOString(),
    }));
    const last = page[page.length - 1];
    res.json({ items, nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null });
  });

  router.post('/admin/settlements/:id/retry', ...guard, async (req, res) => {
    const ok = await retrySettlement(ctx, String(req.params.id));
    if (!ok) throw notFound('No failed settlement with this id');
    res.status(202).json({ queued: true });
  });

  router.get('/admin/revenue', ...guard, async (_req, res) => {
    res.json(await getRevenue(ctx));
  });

  router.get('/admin/health', ...guard, async (_req, res) => {
    res.json(await collectHealth(ctx, true));
  });

  return router;
}
