import { Queue, QueueEvents, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';

export const QUEUE_TRANSCODE = 'transcode';
export const QUEUE_SETTLEMENT = 'settlement';

export interface TranscodeJobData {
  videoId: string;
  /** Local path, or object key when `storage` is "s3" (same shape as the worker's TranscodeJobData). */
  inputPath: string;
  outputDir: string;
  storage?: 'local' | 's3';
}

export interface TranscodeJobResult {
  manifestPath: string;
  thumbnailPath: string;
  durationSeconds: number;
  renditions: string[];
  stats?: { seconds: number; peakRssMiB: number | null };
}

export interface Queues {
  transcode: Queue<TranscodeJobData, TranscodeJobResult>;
  settlement: Queue;
  transcodeEvents: QueueEvents;
  close(): Promise<void>;
}

export function createQueues(connection: Redis): Queues {
  const conn = connection as unknown as ConnectionOptions;
  const transcode = new Queue<TranscodeJobData, TranscodeJobResult>(QUEUE_TRANSCODE, {
    connection: conn,
    defaultJobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 50, removeOnFail: 200 },
  });
  const settlement = new Queue(QUEUE_SETTLEMENT, {
    connection: conn,
    defaultJobOptions: { removeOnComplete: true, removeOnFail: 200 },
  });
  const transcodeEvents = new QueueEvents(QUEUE_TRANSCODE, { connection: connection.duplicate() as unknown as ConnectionOptions });
  return {
    transcode,
    settlement,
    transcodeEvents,
    async close() {
      await Promise.allSettled([transcode.close(), settlement.close(), transcodeEvents.close()]);
    },
  };
}
