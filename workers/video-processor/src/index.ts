import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from './config';
import { startWorker } from './worker';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const config = loadConfig();
const handle = startWorker(config);
process.stdout.write(`video-processor started (concurrency ${config.TRANSCODE_CONCURRENCY}, output ${config.HLS_OUTPUT_DIR})\n`);

let stopping = false;
const stop = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`${signal} received, finishing the current job...\n`);
  handle
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
