import { z } from 'zod';
import { s3SettingsFromEnv, type S3Settings } from '@tesor_gp/storage';
import { DEFAULT_LADDER, parseLadder } from './transcode';

const schema = z.object({
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  HLS_OUTPUT_DIR: z.string().min(1).default('./hls-output'),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  TRANSCODE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  /** Renditions to produce, e.g. "480p" on a small host or "360p,720p,1080p". */
  TRANSCODE_LADDER: z.string().default(DEFAULT_LADDER),
  /** FFmpeg -threads per encode; 0 lets FFmpeg decide. */
  TRANSCODE_THREADS: z.coerce.number().int().min(0).max(64).default(0),
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  /** How long a graceful shutdown waits for the running job before FFmpeg is killed. */
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(60_000),
});
export type WorkerConfig = z.infer<typeof schema> & { s3?: S3Settings };

export function loadConfig(source: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid worker configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  try {
    parseLadder(parsed.data.TRANSCODE_LADDER);
  } catch (err) {
    throw new Error(`Invalid worker configuration: ${(err as Error).message}`, { cause: err });
  }
  return parsed.data.STORAGE_PROVIDER === 's3' ? { ...parsed.data, s3: s3SettingsFromEnv(source) } : parsed.data;
}
