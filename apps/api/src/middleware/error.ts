import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Logger } from '../infra/logger';
import { AppError } from './errors';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
};

/** Central error handler: `{ error: { code, message, details? } }`. Never leaks stack traces. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
      return;
    }
    const e = err as { type?: string; status?: number; code?: string };
    if (e.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' } });
      return;
    }
    if (e.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body too large' } });
      return;
    }
    if (e.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: { code: 'UPLOAD_TOO_LARGE', message: 'File exceeds the upload size limit' } });
      return;
    }
    logger.error({ err, reqId: (req as { id?: unknown }).id, path: req.path }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  };
}
