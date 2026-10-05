import { Redis } from 'ioredis';
import type { Logger } from './logger';

/** BullMQ requires maxRetriesPerRequest: null. Commands queue while Redis is down and flush on reconnect. */
export function createRedis(url: string, logger: Logger, name = 'redis'): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  client.on('error', (err) => logger.warn({ err: err.message, client: name }, 'redis error'));
  return client;
}
