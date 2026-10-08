import express, { Router } from 'express';
import {
  LIVE_FILE_NAME_RE,
  LIVE_SEGMENT_MAX_BYTES,
  chatQuery,
  commitLiveSegmentRequest,
  createLiveRequest,
  liveUploadUrlsRequest,
  postChatRequest,
  startLiveRequest,
} from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { optionalAuth, requireAuth, requireRole, userId } from '../../middleware/auth';
import { badRequest } from '../../middleware/errors';
import { publicWhenAnonymous } from '../../middleware/http-cache';
import { createRateLimiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import * as service from './live.service';
import * as chat from './chat.service';

export function liveRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  // A sender makes about one call per piece (every 4 s); this only stops runaway loops.
  const senderLimit = createRateLimiter(ctx, { name: 'live-sender', max: 120, windowMs: 60_000, keyByUser: true, store: 'memory' });

  // ---------- viewers ----------
  router.get('/live', publicWhenAnonymous(10), optionalAuth(ctx), async (req, res) => {
    res.json(await service.listLiveNow(ctx, req.user?.id));
  });

  // ---------- chat ----------
  // Polled every few seconds by every viewer; anonymous reads are the same for everyone, so the edge may serve them briefly.
  router.get('/live/:streamId/chat', publicWhenAnonymous(2, 5), validate('query', chatQuery), async (req, res) => {
    res.json(await chat.readChat(ctx, String(req.params.streamId), (req.query as { after?: number }).after));
  });

  const chatLimit = createRateLimiter(ctx, { name: 'live-chat', max: 5, windowMs: 10_000, keyByUser: true, store: 'memory' });
  router.post('/live/:streamId/chat', auth, chatLimit, validate('body', postChatRequest), async (req, res) => {
    const role = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId(req) }, select: { role: true } })).role;
    res.status(201).json(await chat.postChat(ctx, { id: userId(req), role }, String(req.params.streamId), (req.body as { text: string }).text));
  });

  router.delete('/live/:streamId/chat/:messageId', auth, async (req, res) => {
    const messageId = Number(req.params.messageId);
    if (!Number.isInteger(messageId) || messageId < 1) throw badRequest('VALIDATION_ERROR', 'Unknown message');
    // The role is read from the database, so a demoted admin cannot moderate with an older login.
    const role = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId(req) }, select: { role: true } })).role;
    await chat.removeChat(ctx, { id: userId(req), role }, String(req.params.streamId), messageId);
    res.status(204).end();
  });

  // ---------- creators ----------
  router.post('/creator/live', auth, validate('body', createLiveRequest), async (req, res) => {
    res.status(201).json(await service.createStream(ctx, userId(req), req.body));
  });

  router.get('/creator/live', auth, async (req, res) => {
    res.json(await service.listOwnStreams(ctx, userId(req)));
  });

  router.get('/creator/live/:id', auth, async (req, res) => {
    res.json(await service.getOwnStream(ctx, userId(req), String(req.params.id)));
  });

  router.post('/creator/live/:id/start', auth, validate('body', startLiveRequest), async (req, res) => {
    res.json(await service.startSending(ctx, userId(req), String(req.params.id), req.body));
  });

  router.post('/creator/live/:id/upload-urls', auth, senderLimit, validate('body', liveUploadUrlsRequest), async (req, res) => {
    res.json(await service.uploadUrls(ctx, userId(req), String(req.params.id), (req.body as { names: string[] }).names));
  });

  // Local disk only (development and tests): the piece comes to the API instead of to a signed storage URL.
  router.put('/creator/live/:id/files/:name', auth, senderLimit, express.raw({ type: () => true, limit: LIVE_SEGMENT_MAX_BYTES }), async (req, res) => {
    const name = String(req.params.name);
    if (!LIVE_FILE_NAME_RE.test(name)) throw badRequest('LIVE_SEGMENT_INVALID', 'Unknown file name');
    await service.storeFile(ctx, userId(req), String(req.params.id), name, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    res.status(204).end();
  });

  router.post('/creator/live/:id/segments', auth, senderLimit, validate('body', commitLiveSegmentRequest), async (req, res) => {
    res.json(await service.commitSegment(ctx, userId(req), String(req.params.id), req.body));
  });

  router.post('/creator/live/:id/thumbnail', auth, async (req, res) => {
    await service.setThumbnail(ctx, userId(req), String(req.params.id));
    res.status(204).end();
  });

  router.post('/creator/live/:id/end', auth, async (req, res) => {
    res.json(await service.endOwnStream(ctx, userId(req), String(req.params.id)));
  });

  // ---------- moderation ----------
  router.post('/admin/live/:id/end', auth, requireRole(ctx, 'ADMIN'), async (req, res) => {
    await service.endStream(ctx, String(req.params.id), 'ENDED_BY_ADMIN');
    res.status(204).end();
  });

  return router;
}
