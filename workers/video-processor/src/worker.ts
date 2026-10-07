import { Redis } from 'ioredis';
import { UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { WorkerConfig } from './config';
import { MediaError } from './ffmpeg';
import { S3Store } from '@tesor_gp/storage';
import { transcodeFromStore } from './storage';
import { parseLadder, transcode, type TranscodeDeps, type TranscodeJobData, type TranscodeJobResult } from './transcode';

export const QUEUE_TRANSCODE = 'transcode';

export interface WorkerHandle {
  worker: Worker<TranscodeJobData, TranscodeJobResult>;
  /** Stops taking jobs, lets the running job finish for up to SHUTDOWN_GRACE_MS, then cancels FFmpeg. */
  close(): Promise<void>;
}

export function startWorker(config: WorkerConfig, log: (msg: string) => void = (m) => process.stdout.write(`${m}\n`)): WorkerHandle {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const shutdown = new AbortController();
  const store = config.s3 ? new S3Store(config.s3) : undefined;
  const ladder = parseLadder(config.TRANSCODE_LADDER);

  const worker = new Worker<TranscodeJobData, TranscodeJobResult>(
    QUEUE_TRANSCODE,
    async (job: Job<TranscodeJobData, TranscodeJobResult>) => {
      log(`transcode ${job.data.videoId}: started (attempt ${job.attemptsMade + 1})`);
      try {
        const deps: TranscodeDeps = {
          ffmpegPath: config.FFMPEG_PATH,
          ffprobePath: config.FFPROBE_PATH,
          ladder,
          ...(config.TRANSCODE_THREADS ? { threads: config.TRANSCODE_THREADS } : {}),
          signal: shutdown.signal,
          onProgress: (percent) => job.updateProgress({ percent }),
        };
        let result: TranscodeJobResult;
        if (job.data.storage === 's3') {
          // A job queued for object storage must never fall back to the local disk (which may be wiped).
          if (!store) throw new UnrecoverableError('This job needs STORAGE_PROVIDER=s3 on the worker');
          result = await transcodeFromStore(store, job.data, deps);
        } else {
          result = await transcode(job.data, deps);
        }
        const s = result.stats;
        log(
          `transcode ${job.data.videoId}: done (${result.renditions.join(', ')})` +
            (s ? ` in ${s.seconds}s for ${Math.round(result.durationSeconds)}s of video, peak FFmpeg memory ${s.peakRssMiB ?? '?'} MiB, threads ${config.TRANSCODE_THREADS || 'auto'}` : ''),
        );
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`transcode ${job.data.videoId}: failed: ${message}`);
        // Corrupt or unsupported input will not get better on a second attempt.
        if (err instanceof MediaError && err.permanent) throw new UnrecoverableError(message);
        throw err instanceof Error ? err : new Error(message);
      }
    },
    { connection: connection as unknown as ConnectionOptions, concurrency: config.TRANSCODE_CONCURRENCY },
  );
  worker.on('error', (err) => log(`worker error: ${err.message}`));

  return {
    worker,
    async close() {
      const timer = setTimeout(() => shutdown.abort(), config.SHUTDOWN_GRACE_MS);
      try {
        await worker.close();
      } finally {
        clearTimeout(timer);
        await connection.quit().catch(() => undefined);
      }
    },
  };
}
