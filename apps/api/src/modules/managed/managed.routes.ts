import { Router } from 'express';
import { bankMoneyRequest } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { requireAuth, userId } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { getSummary } from '../wallet/wallet.service';
import { buyCoins } from './coins';
import { requestPayout } from './payout';

/** Built-in wallets: buying coins and creator payouts. Both end in a transaction the platform's relayer pays for. */
export function managedRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const limiter = createRateLimiter(ctx, { name: 'coins', max: 30, keyByUser: true });

  router.post('/wallet/topup', auth, limiter, validate('body', bankMoneyRequest), async (req, res) => {
    const order = await buyCoins(ctx, userId(req), req.body);
    res.status(202).json({ ...order, summary: await getSummary(ctx, userId(req)) });
  });

  router.post('/creator/earnings/payout', auth, limiter, async (req, res) => {
    res.status(202).json(await requestPayout(ctx, userId(req)));
  });

  return router;
}
