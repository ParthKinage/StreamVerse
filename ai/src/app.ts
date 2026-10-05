import express, { type ErrorRequestHandler } from 'express';
import { aiRecommendRequest } from '@tesor_gp/shared';
import { recommend } from './scoring';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/recommend', (req, res) => {
    const parsed = aiRecommendRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
      return;
    }
    res.json({ items: recommend(parsed.data) });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
  const onError: ErrorRequestHandler = (err: { type?: string; status?: number }, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' } });
      return;
    }
    if (err.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body too large' } });
      return;
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  };
  app.use(onError);
  return app;
}
