import { Router } from 'express';
import { z } from 'zod';
import { createReportRequest, moderationReasonRequest, resolveReportRequest } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { requireAuth, requireRole, userId } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import * as service from './moderation.service';

const statusQuery = z.object({ status: z.enum(['OPEN', 'DISMISSED', 'ACTIONED']).default('OPEN') });

export function moderationRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const guard = [auth, requireRole(ctx, 'ADMIN')];
  const reportLimit = createRateLimiter(ctx, { name: 'reports', max: 20, windowMs: 60 * 60_000, keyByUser: true });

  // ---------- viewers ----------
  router.post('/reports', auth, reportLimit, validate('body', createReportRequest), async (req, res) => {
    res.status(201).json(await service.createReport(ctx, userId(req), req.body));
  });

  // ---------- admins ----------
  router.get('/admin/overview', ...guard, async (_req, res) => {
    res.json(await service.overview(ctx));
  });

  router.get('/admin/reports', ...guard, validate('query', statusQuery), async (req, res) => {
    res.json(await service.listReports(ctx, (req.query as unknown as { status: 'OPEN' | 'DISMISSED' | 'ACTIONED' }).status));
  });

  router.post('/admin/reports/resolve', ...guard, validate('body', resolveReportRequest), async (req, res) => {
    res.json(await service.resolveReports(ctx, userId(req), req.body));
  });

  router.post('/admin/users/:id/suspend', ...guard, validate('body', moderationReasonRequest), async (req, res) => {
    await service.suspendUser(ctx, userId(req), String(req.params.id), (req.body as { reason?: string }).reason);
    res.status(204).end();
  });

  router.post('/admin/users/:id/unsuspend', ...guard, async (req, res) => {
    await service.unsuspendUser(ctx, String(req.params.id));
    res.status(204).end();
  });

  router.post('/admin/videos/:id/hide', ...guard, validate('body', moderationReasonRequest), async (req, res) => {
    await service.hideVideo(ctx, String(req.params.id), (req.body as { reason?: string }).reason);
    res.status(204).end();
  });

  router.post('/admin/videos/:id/unhide', ...guard, async (req, res) => {
    await service.unhideVideo(ctx, String(req.params.id));
    res.status(204).end();
  });

  return router;
}
