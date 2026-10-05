import { Redis } from 'ioredis';
import { UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { WorkerConfig } from './config';
import { MediaError } from './ffmpeg';
import { transcode, type TranscodeJobData, type TranscodeJobResult } from './transcode';

export const QUEUE_TRANSCODE = 'transcode';

export interface WorkerHandle {
  worker: Worker<TranscodeJobData, TranscodeJobResult>;
  /** Stops taking jobs, lets the running job finish for up to SHUTDOWN_GRACE_MS, then cancels FFmpeg. */
  close(): Promise<void>;
}

export function startWorker(config: WorkerConfig, log: (msg: string) => void = (m) => process.stdout.write(`${m}\n`)): WorkerHandle {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const shutdown = new AbortController();

  const worker = new Worker<TranscodeJobData, TranscodeJobResult>(
    QUEUE_TRANSCODE,
    async (job: Job<TranscodeJobData, TranscodeJobResult>) => {
      log(`transcode ${job.data.videoId}: started (attempt ${job.attemptsMade + 1})`);
      try {
        const result = await transcode(job.data, {
          ffmpegPath: config.FFMPEG_PATH,
          ffprobePath: config.FFPROBE_PATH,
          signal: shutdown.signal,
          onProgress: (percent) => job.updateProgress({ percent }),
        });
        log(`transcode ${job.data.videoId}: done (${result.renditions.join(', ')})`);
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
