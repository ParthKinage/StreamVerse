import { z } from 'zod';

const schema = z.object({
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  HLS_OUTPUT_DIR: z.string().min(1).default('./hls-output'),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  TRANSCODE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  /** How long a graceful shutdown waits for the running job before FFmpeg is killed. */
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(60_000),
});
export type WorkerConfig = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid worker configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}
