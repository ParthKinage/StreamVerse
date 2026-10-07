import { DOMAIN_EVENTS } from '@tesor_gp/shared';
import type { AppContext } from '../../context';

export const MEDIA_MISSING_REASON = 'The video files are no longer in storage. Upload the video again.';

/**
 * Finds videos marked playable whose files are gone (for example local files wiped by a restart on free hosting) and
 * marks them FAILED, so the catalog never lists a video that cannot play. A storage error is never taken as
 * "missing": the video is skipped and checked again next time.
 */
export async function reconcileMissingMedia(ctx: AppContext, batchSize = 200): Promise<{ checked: number; failed: string[] }> {
  const failed: string[] = [];
  let checked = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows = await ctx.prisma.video.findMany({
      where: { processingStatus: 'COMPLETED', archivedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, hlsManifestPath: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1]!.id;
    for (const v of rows) {
      checked++;
      let present: boolean;
      try {
        present = Boolean(v.hlsManifestPath) && (await ctx.storage.exists(v.hlsManifestPath as string));
      } catch (err) {
        ctx.logger.warn({ videoId: v.id, err: (err as Error).message }, 'media check skipped: storage unavailable');
        continue;
      }
      if (present) continue;
      const updated = await ctx.prisma.video.updateMany({
        where: { id: v.id, processingStatus: 'COMPLETED' },
        data: { processingStatus: 'FAILED', failureReason: MEDIA_MISSING_REASON, isPublished: false },
      });
      if (updated.count) {
        failed.push(v.id);
        ctx.events.emit(DOMAIN_EVENTS.VIDEO_PROCESSED, { videoId: v.id, status: 'FAILED' });
      }
    }
    if (rows.length < batchSize) break;
  }
  if (failed.length) ctx.logger.warn({ count: failed.length, videoIds: failed.slice(0, 20) }, 'videos with missing files marked FAILED');
  return { checked, failed };
}

/** Runs the check shortly after startup and then every MEDIA_RECONCILE_EVERY_MIN minutes (0 disables it). */
export function startMediaReconciler(ctx: AppContext, firstRunDelayMs = 30_000): { stop(): void } {
  const everyMin = ctx.env.MEDIA_RECONCILE_EVERY_MIN;
  if (!everyMin) return { stop: () => undefined };
  const run = (): void => void reconcileMissingMedia(ctx).catch((err) => ctx.logger.warn({ err: (err as Error).message }, 'media reconcile failed'));
  const first = setTimeout(run, firstRunDelayMs);
  const timer = setInterval(run, everyMin * 60_000);
  first.unref();
  timer.unref();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
