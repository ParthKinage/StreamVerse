import crypto from 'node:crypto';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import {
  ALLOWED_UPLOAD_MIME,
  completeUploadRequest,
  createCreatorProfileRequest,
  createUploadRequest,
  cursorQuery,
  updateVideoRequest,
  uploadVideoFields,
} from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { requireAuth, userId } from '../../middleware/auth';
import { originalKey } from '@tesor_gp/storage';
import { AppError, badRequest, conflict, forbidden } from '../../middleware/errors';
import { validate } from '../../middleware/validate';
import { probeMedia } from '../media';
import * as service from './creator.service';
import { signUploadToken, verifyUploadToken } from './upload-token';

/** Extra time after the upload URL expires to call /complete (a large file may finish uploading just in time). */
const COMPLETE_GRACE_SEC = 3600;

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
    let stored: string | undefined;
    try {
      const fields = uploadVideoFields.parse(req.body);
      const probe = await probeMedia(ctx.env.FFPROBE_PATH, file.path).catch(() => undefined);
      if (!probe?.hasVideo) throw badRequest('UPLOAD_INVALID', 'The file does not contain a playable video stream');
      await service.requireCreatorProfile(ctx, userId(req));
      stored = await ctx.storage.storeOriginal(file.path, userId(req));
      const video = await service.createVideo(ctx, userId(req), fields, stored);
      res.status(201).json(video);
    } catch (err) {
      await ctx.storage.deleteFile(file.path).catch(() => undefined);
      if (stored && stored !== file.path) await ctx.storage.deleteFile(stored).catch(() => undefined);
      throw err;
    }
  });

  /**
   * Direct upload, step 1 (object storage only): returns a signed URL the browser PUTs the file to, so the video never
   * passes through Vercel or the API.
   */
  router.post('/creator/uploads', auth, validate('body', createUploadRequest), async (req, res) => {
    const s3 = ctx.storage.s3;
    if (!s3) throw conflict('NOT_AVAILABLE_IN_THIS_MODE', 'Direct upload needs object storage; upload with POST /creator/videos');
    const uid = userId(req);
    await service.requireCreatorProfile(ctx, uid);
    const { fileName, contentType, sizeBytes } = req.body as { fileName: string; contentType: string; sizeBytes: number };
    const ext = path.extname(fileName).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw badRequest('UPLOAD_INVALID', 'Unsupported file type. Upload an MP4, MOV, MKV, WebM or AVI video.');
    if (sizeBytes > ctx.env.MAX_UPLOAD_MB * 1024 * 1024) throw new AppError(413, 'UPLOAD_TOO_LARGE', `Videos can be at most ${ctx.env.MAX_UPLOAD_MB} MB`);

    const key = originalKey(uid, `${crypto.randomUUID()}${ext}`);
    const ttl = ctx.env.UPLOAD_URL_TTL_SEC;
    const now = Math.floor(ctx.now().getTime() / 1000);
    res.status(201).json({
      uploadToken: signUploadToken({ k: key, u: uid, s: sizeBytes, t: contentType, exp: now + ttl + COMPLETE_GRACE_SEC }, ctx.env.PLAYBACK_SIGNING_SECRET),
      uploadUrl: await s3.signedPutUrl(key, contentType, ttl),
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      expiresAt: new Date((now + ttl) * 1000).toISOString(),
    });
  });

  /** Direct upload, step 2: checks the object (size, type, a real video stream) and queues it for transcoding. */
  router.post('/creator/uploads/complete', auth, validate('body', completeUploadRequest), async (req, res) => {
    const s3 = ctx.storage.s3;
    if (!s3) throw conflict('NOT_AVAILABLE_IN_THIS_MODE', 'Direct upload needs object storage; upload with POST /creator/videos');
    const uid = userId(req);
    const { uploadToken, ...fields } = req.body as { uploadToken: string } & Parameters<typeof service.createVideo>[2];
    const claims = verifyUploadToken(uploadToken, ctx.env.PLAYBACK_SIGNING_SECRET, Math.floor(ctx.now().getTime() / 1000));
    if (!claims) throw badRequest('UPLOAD_INVALID', 'This upload has expired or is not valid. Start the upload again.');
    if (claims.u !== uid) throw forbidden('This upload belongs to another account');

    // Completing twice (a retried request) returns the video created the first time.
    const existing = await service.findVideoByOriginal(ctx, uid, claims.k);
    if (existing) return void res.status(200).json(existing);

    const head = await s3.head(claims.k);
    if (!head) throw new AppError(400, 'UPLOAD_NOT_FOUND', 'The file has not arrived in storage yet. Finish the upload, then try again.');
    const reject = async (err: AppError): Promise<never> => {
      await s3.deleteKey(claims.k).catch(() => undefined);
      throw err;
    };
    if (head.size <= 0 || head.size > claims.s || head.size > ctx.env.MAX_UPLOAD_MB * 1024 * 1024) {
      await reject(new AppError(413, 'UPLOAD_TOO_LARGE', 'The uploaded file is empty or larger than announced'));
    }
    if (head.contentType && head.contentType !== claims.t) await reject(badRequest('UPLOAD_INVALID', 'The uploaded file type does not match the announced type'));
    const probe = await probeMedia(ctx.env.FFPROBE_PATH, await s3.signedGetUrl(claims.k, 300), 60_000).catch(() => undefined);
    if (!probe?.hasVideo) await reject(badRequest('UPLOAD_INVALID', 'The file does not contain a playable video stream'));

    res.status(201).json(await service.createVideo(ctx, uid, fields, claims.k));
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
