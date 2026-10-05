import crypto from 'node:crypto';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import {
  ALLOWED_UPLOAD_MIME,
  createCreatorProfileRequest,
  cursorQuery,
  updateVideoRequest,
  uploadVideoFields,
} from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { requireAuth, userId } from '../../middleware/auth';
import { badRequest } from '../../middleware/errors';
import { validate } from '../../middleware/validate';
import { probeMedia } from '../media';
import * as service from './creator.service';

const ALLOWED_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi']);

export function creatorRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, ctx.storage.uploadDir),
      filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: ctx.env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!ALLOWED_EXT.has(ext) || !(ALLOWED_UPLOAD_MIME as readonly string[]).includes(file.mimetype)) {
        return cb(badRequest('UPLOAD_INVALID', 'Unsupported file type. Upload an MP4, MOV, MKV, WebM or AVI video.'));
      }
      cb(null, true);
    },
  });

  router.post('/creator/profile', auth, validate('body', createCreatorProfileRequest), async (req, res) => {
    const { user, created } = await service.becomeCreator(ctx, userId(req), req.body);
    res.status(created ? 201 : 200).json({ user });
  });

  router.post('/creator/videos', auth, upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('UPLOAD_INVALID', 'Attach a video file in the "file" field');
    try {
      const fields = uploadVideoFields.parse(req.body);
      const probe = await probeMedia(ctx.env.FFPROBE_PATH, file.path).catch(() => undefined);
      if (!probe?.hasVideo) throw badRequest('UPLOAD_INVALID', 'The file does not contain a playable video stream');
      const video = await service.createVideo(ctx, userId(req), fields, file.path);
      res.status(201).json(video);
    } catch (err) {
      await ctx.storage.deleteFile(file.path).catch(() => undefined);
      throw err;
    }
  });

  router.get('/creator/videos', auth, validate('query', cursorQuery), async (req, res) => {
    const q = req.query as unknown as { cursor?: string; limit: number };
    res.json(await service.listOwnVideos(ctx, userId(req), q.cursor, q.limit));
  });

  router.patch('/creator/videos/:id', auth, validate('body', updateVideoRequest), async (req, res) => {
    res.json(await service.updateVideo(ctx, userId(req), String(req.params.id), req.body));
  });

  router.post('/creator/videos/:id/publish', auth, async (req, res) => {
    res.json(await service.setPublished(ctx, userId(req), String(req.params.id), true));
  });

  router.post('/creator/videos/:id/unpublish', auth, async (req, res) => {
    res.json(await service.setPublished(ctx, userId(req), String(req.params.id), false));
  });

  router.post('/creator/videos/:id/retry', auth, async (req, res) => {
    res.json(await service.retryTranscode(ctx, userId(req), String(req.params.id)));
  });

  router.delete('/creator/videos/:id', auth, async (req, res) => {
    await service.archiveVideo(ctx, userId(req), String(req.params.id));
    res.status(204).end();
  });

  router.get('/creator/analytics', auth, async (req, res) => {
    res.json(await service.getAnalytics(ctx, userId(req)));
  });

  router.get('/creator/earnings', auth, async (req, res) => {
    res.json(await service.getEarnings(ctx, userId(req)));
  });

  return router;
}
