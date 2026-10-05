import { ChainAdapter, loadDeployment, type Deployment } from '@tesor_gp/blockchain';
import { getPrisma, type PrismaClient } from '@tesor_gp/database';
import type { Redis } from 'ioredis';
import type { Env } from './config/env';
import { createAiClient, type AiClient } from './modules/ai-client';
import { EventBus } from './infra/events';
import { createLogger, type Logger } from './infra/logger';
import { createQueues, type Queues } from './infra/queues';
import { createRedis } from './infra/redis';
import { createStorage, type StorageProvider } from './infra/storage';

export interface AppContext {
  env: Env;
  logger: Logger;
  prisma: PrismaClient;
  redis: Redis;
  queues: Queues;
  chain: ChainAdapter | undefined;
  deployment: Deployment | undefined;
  events: EventBus;
  storage: StorageProvider;
  ai: AiClient;
  /** Injectable clock so billing logic is testable. */
  now: () => Date;
  close(): Promise<void>;
}

export interface ContextOverrides {
  now?: () => Date;
  ai?: AiClient;
  chain?: ChainAdapter | undefined;
  deployment?: Deployment | undefined;
  prisma?: PrismaClient;
}

export function createContext(env: Env, overrides: ContextOverrides = {}): AppContext {
  const logger = createLogger(env);
  const prisma = overrides.prisma ?? getPrisma(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL, logger);
  const queues = createQueues(redis);
  const storage = createStorage(env);
  const events = new EventBus(logger);

  const deployment = 'deployment' in overrides ? overrides.deployment : env.PAYMENTS_MODE === 'bank' ? undefined : loadDeployment(env.CHAIN_ID, env);
  let chain: ChainAdapter | undefined;
  if ('chain' in overrides) {
    chain = overrides.chain;
  } else if (deployment) {
    chain = new ChainAdapter({
      rpcUrl: env.RPC_URL,
      chainId: env.CHAIN_ID,
      streamCoinAddress: deployment.streamCoin,
      paymentRouterAddress: deployment.paymentRouter,
      relayerPrivateKey: env.SETTLEMENT_RELAYER_PRIVATE_KEY,
      confirmations: env.CONFIRMATIONS,
    });
  } else if (env.PAYMENTS_MODE === 'chain') {
    logger.warn('Contract addresses are not configured; blockchain features are disabled until they are set');
  }

  return {
    env,
    logger,
    prisma,
    redis,
    queues,
    chain,
    deployment,
    events,
    storage,
    ai: overrides.ai ?? createAiClient(env.AI_SERVICE_URL, env.AI_TIMEOUT_MS),
    now: overrides.now ?? (() => new Date()),
    async close() {
      await queues.close();
      chain?.destroy();
      redis.disconnect();
    },
  };
}
