import crypto from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { AppContext } from './context';
import { errorHandler, notFoundHandler } from './middleware/error';
import { noStore, serverTiming } from './middleware/http-cache';
import { createRateLimiter } from './middleware/rateLimit';
import { adminRoutes } from './modules/admin';
import { authRoutes } from './modules/auth';
import { bankRoutes } from './modules/bank';
import { purchaseRoutes } from './modules/purchase';
import { catalogRoutes } from './modules/catalog';
import { managedRoutes } from './modules/managed';
import { creatorRoutes } from './modules/creator';
import { opsRoutes } from './modules/ops';
import { playbackRoutes } from './modules/playback';
import { recommendationRoutes } from './modules/recommendations';
import { socialRoutes } from './modules/social';
import { usersRoutes } from './modules/users';
import { walletRoutes } from './modules/wallet';
import { watchRoutes } from './modules/watch';

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    req.id = (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });
  app.use(serverTiming);
  app.use(pinoHttp({ logger: ctx.logger, genReqId: (req) => req.id ?? crypto.randomUUID(), autoLogging: { ignore: (req) => req.url === '/health' } }));
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: [ctx.env.WEB_BASE_URL], credentials: true }));
  app.use(cookieParser(ctx.env.COOKIE_SECRET));

  // Liveness/readiness first: no body parsing or rate limiting.
  app.use(opsRoutes(ctx));
  app.use(playbackRoutes(ctx));

  const api = express.Router();
  // JSON only: media is never compressed (playback is mounted above, outside this router).
  api.use(compression({ threshold: 1024 }));
  api.use(noStore);
  api.use(express.json({ limit: '100kb' }));
  api.use(createRateLimiter(ctx, { name: 'global', max: ctx.env.RATE_LIMIT_MAX, store: 'memory' }));
  api.use(opsRoutes(ctx));
  api.use('/auth', authRoutes(ctx));
  for (const router of [
    usersRoutes(ctx),
    walletRoutes(ctx),
    bankRoutes(ctx),
    managedRoutes(ctx),
    purchaseRoutes(ctx),
    catalogRoutes(ctx),
    creatorRoutes(ctx),
    watchRoutes(ctx),
    recommendationRoutes(ctx),
    socialRoutes(ctx),
    adminRoutes(ctx),
  ]) {
    api.use(router);
  }
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler(ctx.logger));
  return app;
}
