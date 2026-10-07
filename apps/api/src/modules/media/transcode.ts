import type { Job } from 'bullmq';
import { DOMAIN_EVENTS } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import type { TranscodeJobData, TranscodeJobResult } from '../../infra/queues';

export const transcodeJobId = (videoId: string): string => `transcode-${videoId}`;
const videoIdFromJob = (jobId: string): string | undefined => (jobId.startsWith('transcode-') ? jobId.slice('transcode-'.length) : undefined);

export async function enqueueTranscode(ctx: AppContext, videoId: string, inputPath: string): Promise<void> {
  const target = ctx.storage.transcodeTarget(videoId);
  if (!target) throw new Error('Invalid video id');
  const old = await ctx.queues.transcode.getJob(transcodeJobId(videoId));
  if (old) await old.remove().catch(() => undefined);
  await ctx.queues.transcode.add('transcode', { videoId, inputPath, ...target }, { jobId: transcodeJobId(videoId) });
}

async function applyResult(ctx: AppContext, videoId: string, result: TranscodeJobResult): Promise<void> {
  const updated = await ctx.prisma.video.updateMany({
    where: { id: videoId, processingStatus: { in: ['PENDING', 'PROCESSING'] } },
    data: {
      processingStatus: 'COMPLETED',
      transcodeProgress: 100,
      failureReason: null,
      hlsManifestPath: result.manifestPath,
      thumbnailPath: result.thumbnailPath,
      durationSeconds: Math.max(0, Math.round(result.durationSeconds)),
    },
  });
  if (updated.count) ctx.events.emit(DOMAIN_EVENTS.VIDEO_PROCESSED, { videoId, status: 'COMPLETED' });
}

async function applyFailure(ctx: AppContext, videoId: string, reason: string): Promise<void> {
  const updated = await ctx.prisma.video.updateMany({
    where: { id: videoId, processingStatus: { in: ['PENDING', 'PROCESSING'] } },
    data: { processingStatus: 'FAILED', failureReason: reason.slice(0, 500), isPublished: false },
  });
  if (updated.count) ctx.events.emit(DOMAIN_EVENTS.VIDEO_PROCESSED, { videoId, status: 'FAILED' });
}

/**
 * The API is the only writer of processing state (spec). It listens to queue events and also reconciles from job state
 * periodically, so a missed event (API restart, Redis blip) cannot leave a video stuck.
 */
export function startTranscodeListener(ctx: AppContext, reconcileEveryMs = 10_000): { stop(): Promise<void> } {
  const events = ctx.queues.transcodeEvents;

  events.on('active', ({ jobId }) => {
    const id = videoIdFromJob(jobId);
    if (id) void ctx.prisma.video.updateMany({ where: { id, processingStatus: 'PENDING' }, data: { processingStatus: 'PROCESSING' } }).catch(() => undefined);
  });
  events.on('progress', ({ jobId, data }) => {
    const id = videoIdFromJob(jobId);
    const pct = typeof data === 'number' ? data : Number((data as { percent?: number })?.percent);
    if (id && Number.isFinite(pct)) {
      void ctx.prisma.video
        .updateMany({ where: { id, processingStatus: { in: ['PENDING', 'PROCESSING'] } }, data: { processingStatus: 'PROCESSING', transcodeProgress: Math.min(99, Math.max(0, Math.round(pct))) } })
        .catch(() => undefined);
    }
  });
  events.on('completed', ({ jobId, returnvalue }) => {
    const id = videoIdFromJob(jobId);
    const result = (typeof returnvalue === 'string' ? safeParse(returnvalue) : returnvalue) as TranscodeJobResult | undefined;
    if (id && result?.manifestPath) void applyResult(ctx, id, result).catch((err) => ctx.logger.error({ err }, 'apply transcode result'));
  });
  events.on('failed', ({ jobId, failedReason }) => {
    const id = videoIdFromJob(jobId);
    if (id) void applyFailure(ctx, id, failedReason || 'Transcoding failed').catch((err) => ctx.logger.error({ err }, 'apply transcode failure'));
  });

  const reconcile = async (): Promise<void> => {
    try {
      const stuck = await ctx.prisma.video.findMany({
        where: { processingStatus: { in: ['PENDING', 'PROCESSING'] }, archivedAt: null },
        select: { id: true, originalFilePath: true, createdAt: true },
        take: 50,
      });
      for (const v of stuck) {
        const job = (await ctx.queues.transcode.getJob(transcodeJobId(v.id))) as Job<TranscodeJobData, TranscodeJobResult> | undefined;
        if (!job) {
          if (ctx.now().getTime() - v.createdAt.getTime() > 15_000) await enqueueTranscode(ctx, v.id, v.originalFilePath);
          continue;
        }
        const state = await job.getState();
        if (state === 'completed' && job.returnvalue) await applyResult(ctx, v.id, job.returnvalue);
        else if (state === 'failed') await applyFailure(ctx, v.id, job.failedReason || 'Transcoding failed');
      }
    } catch (err) {
      ctx.logger.warn({ err: (err as Error).message }, 'transcode reconcile failed');
    }
  };
  const timer = setInterval(() => void reconcile(), reconcileEveryMs);
  void reconcile();
  return {
    async stop() {
      clearInterval(timer);
    },
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
