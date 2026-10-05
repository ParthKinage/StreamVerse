import { Router } from 'express';
import { bankCashOutRequest, bankMoneyRequest, cursorQuery } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { requireAuth, userId } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { getSummary } from '../wallet/wallet.service';
import * as service from './bank.service';

export function bankRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const limiter = createRateLimiter(ctx, { name: 'bank', max: 30, keyByUser: true });

  router.post('/bank/topup', auth, limiter, validate('body', bankMoneyRequest), async (req, res) => {
    await service.topUp(ctx, userId(req), req.body);
    res.status(201).json({ summary: await getSummary(ctx, userId(req)) });
  });

  router.post('/bank/withdraw', auth, limiter, validate('body', bankMoneyRequest), async (req, res) => {
    await service.withdrawToBank(ctx, userId(req), req.body);
    res.json({ summary: await getSummary(ctx, userId(req)) });
  });

  router.post('/bank/cashout', auth, limiter, validate('body', bankCashOutRequest), async (req, res) => {
    const result = await service.cashOutEarnings(ctx, userId(req), req.body.accountId);
    res.json({ ...result, summary: await getSummary(ctx, userId(req)) });
  });

  router.get('/creator/received', auth, validate('query', cursorQuery), async (req, res) => {
    const q = req.query as unknown as { cursor?: string; limit: number };
    res.json(await service.listReceived(ctx, userId(req), q.cursor, q.limit));
  });

  return router;
}
