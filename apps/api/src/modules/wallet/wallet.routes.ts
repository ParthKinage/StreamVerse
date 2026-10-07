import { Router } from 'express';
import { publicWhenAnonymous } from '../../middleware/http-cache';
import { cursorQuery, linkWalletRequest, nonceRequest } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { requireAuth, userId } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import * as service from './wallet.service';

export function walletRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const limiter = createRateLimiter(ctx, { name: 'wallet', max: 30, keyByUser: false });

  router.get('/config', publicWhenAnonymous(60), (_req, res) => {
    res.json(service.getConfig(ctx));
  });

  router.post('/wallet/nonce', auth, limiter, validate('body', nonceRequest), async (req, res) => {
    res.json(await service.createNonce(ctx, userId(req), req.body.address));
  });

  router.post('/wallet/link', auth, limiter, validate('body', linkWalletRequest), async (req, res) => {
    res.json({ user: await service.linkWallet(ctx, userId(req), req.body.address, req.body.signature) });
  });

  router.delete('/wallet/link', auth, async (req, res) => {
    res.json({ user: await service.unlinkWallet(ctx, userId(req)) });
  });

  router.get('/wallet/summary', auth, async (req, res) => {
    res.json(await service.getSummary(ctx, userId(req)));
  });

  router.get('/wallet/transactions', auth, validate('query', cursorQuery), async (req, res) => {
    const q = req.query as unknown as { cursor?: string; limit: number };
    res.json(await service.listTransactions(ctx, userId(req), q.cursor, q.limit));
  });

  return router;
}
