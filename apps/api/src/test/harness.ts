import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { Contract, JsonRpcProvider, Network, Wallet, parseEther } from 'ethers';
import supertest from 'supertest';
import { inject } from 'vitest';
import { ChainAdapter, PAYMENT_ROUTER_ABI, STREAM_COIN_ABI } from '@tesor_gp/blockchain';
import { getPrisma } from '@tesor_gp/database';
import { createApp } from '../app';
import { parseEnv, type Env } from '../config/env';
import { createContext, type AppContext, type ContextOverrides } from '../context';
import { indexUntilCaughtUp } from '../modules/indexer';
import { resetFeeCache } from '../modules/settlement';

export class Clock {
  constructor(public t = Date.now()) {}
  now = (): Date => new Date(this.t);
  advance(seconds: number): void {
    this.t += seconds * 1000;
  }
}

export interface Harness {
  ctx: AppContext;
  app: ReturnType<typeof createApp>;
  clock: Clock;
  env: Env;
  provider: JsonRpcProvider;
  deployer: Wallet;
  hlsDir: string;
  uploadDir: string;
  req: () => ReturnType<typeof supertest>;
  close(): Promise<void>;
}

export async function createHarness(options: { overrides?: ContextOverrides; env?: Record<string, string>; useChain?: boolean } = {}): Promise<Harness> {
  const chain = inject('chain');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tesor-api-'));
  const hlsDir = path.join(tmp, 'hls');
  const uploadDir = path.join(tmp, 'uploads');
  const useChain = options.useChain ?? true;
  const env = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: inject('dbUrl'),
    REDIS_URL: inject('redisUrl'),
    JWT_SECRET: 'test-jwt-secret-0123456789',
    COOKIE_SECRET: 'test-cookie-secret-0123456789',
    PLAYBACK_SIGNING_SECRET: 'test-playback-secret-0123456789',
    PAYMENTS_MODE: 'chain',
    CHAIN_ID: String(chain.chainId),
    RPC_URL: chain.rpcUrl,
    STREAMCOIN_TOKEN_ADDRESS: chain.streamCoin,
    PAYMENT_ROUTER_ADDRESS: chain.paymentRouter,
    SETTLEMENT_RELAYER_PRIVATE_KEY: chain.deployerKey,
    CONFIRMATIONS: '1',
    UPLOAD_DIR: uploadDir,
    HLS_OUTPUT_DIR: hlsDir,
    RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_MAX: '100000',
    BCRYPT_ROUNDS: '4',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    SETTLE_MAX_ATTEMPTS: '3',
    ...options.env,
  } as NodeJS.ProcessEnv);

  const clock = new Clock();
  const prisma = getPrisma(env.DATABASE_URL);
  const ctx = createContext(env, {
    now: clock.now,
    prisma,
    deployment: useChain
      ? { chainId: chain.chainId, streamCoin: chain.streamCoin, paymentRouter: chain.paymentRouter, deploymentBlock: chain.deploymentBlock, feeBps: chain.feeBps, withdrawDelaySec: chain.withdrawDelaySec }
      : undefined,
    ...(useChain
      ? {
          chain: new ChainAdapter({
            rpcUrl: env.RPC_URL,
            chainId: chain.chainId,
            streamCoinAddress: chain.streamCoin,
            paymentRouterAddress: chain.paymentRouter,
            relayerPrivateKey: chain.deployerKey,
            confirmations: 1,
            timeoutMs: 4000,
            retries: 1,
            retryBaseDelayMs: 50,
          }),
        }
      : { chain: undefined }),
    ...options.overrides,
  });
  await resetDb(ctx);
  resetFeeCache();
  const app = createApp(ctx);
  const provider = new JsonRpcProvider(env.RPC_URL, chain.chainId, { staticNetwork: Network.from(chain.chainId), cacheTimeout: -1, polling: true, pollingInterval: 100 });
  const deployer = new Wallet(chain.deployerKey, provider);
  return {
    ctx,
    app,
    clock,
    env,
    provider,
    deployer,
    hlsDir,
    uploadDir,
    req: () => supertest(app),
    async close() {
      provider.destroy();
      await ctx.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export async function resetDb(ctx: AppContext): Promise<void> {
  await ctx.prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "User","RefreshToken","CreatorProfile","Video","WatchSession","WatchHeartbeat","PaymentSettlement","TokenReward","EscrowAccount","ChainEvent","ChainCursor","WatchlistItem","VideoLike" CASCADE',
  );
  await ctx.redis.flushdb();
  for (const q of [ctx.queues.settlement, ctx.queues.transcode]) await q.obliterate({ force: true }).catch(() => undefined);
}

let counter = 0;
export const uniq = (prefix = 'u'): string => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

export interface TestUser {
  id: string;
  token: string;
  email: string;
  username: string;
  password: string;
  cookies: string[];
}

export async function registerUser(h: Harness, overrides: Partial<{ email: string; username: string; password: string }> = {}): Promise<TestUser> {
  const username = overrides.username ?? uniq('user');
  const email = overrides.email ?? `${username}@example.test`;
  const password = overrides.password ?? 'Passw0rd!123';
  const res = await h.req().post('/api/v1/auth/register').send({ email, username, password });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.user.id, token: res.body.accessToken, email, username, password, cookies: res.headers['set-cookie'] as unknown as string[] };
}

export const authed = (h: Harness, user: Pick<TestUser, 'token'>) => ({
  get: (url: string) => h.req().get(url).set('Authorization', `Bearer ${user.token}`),
  post: (url: string) => h.req().post(url).set('Authorization', `Bearer ${user.token}`),
  patch: (url: string) => h.req().patch(url).set('Authorization', `Bearer ${user.token}`),
  delete: (url: string) => h.req().delete(url).set('Authorization', `Bearer ${user.token}`),
});

/** A fresh funded (ETH) wallet; STRM is added separately. */
export async function newWallet(h: Harness): Promise<Wallet> {
  const wallet = new Wallet(Wallet.createRandom().privateKey, h.provider);
  await h.provider.send('hardhat_setBalance', [wallet.address, '0x' + parseEther('10').toString(16)]);
  return wallet;
}

export async function linkWallet(h: Harness, user: Pick<TestUser, 'token'>, wallet: Wallet): Promise<void> {
  const api = authed(h, user);
  const nonce = await api.post('/api/v1/wallet/nonce').send({ address: wallet.address });
  if (nonce.status !== 200) throw new Error(`nonce failed ${JSON.stringify(nonce.body)}`);
  const signature = await wallet.signMessage(nonce.body.message);
  const link = await api.post('/api/v1/wallet/link').send({ address: wallet.address, signature });
  if (link.status !== 200) throw new Error(`link failed ${JSON.stringify(link.body)}`);
}

const router = (h: Harness, signer: Wallet): Contract => new Contract(h.ctx.deployment!.paymentRouter, PAYMENT_ROUTER_ABI, signer);
const coin = (h: Harness, signer: Wallet): Contract => new Contract(h.ctx.deployment!.streamCoin, STREAM_COIN_ABI, signer);

/** Gives `wallet` STRM from the deployer, approves the router and deposits `strm` into escrow, then indexes. */
export async function fundAndDeposit(h: Harness, wallet: Wallet, strm: string): Promise<void> {
  const amount = parseEther(strm);
  await (await coin(h, h.deployer).getFunction('transfer')(wallet.address, amount)).wait();
  await (await coin(h, wallet).getFunction('approve')(h.ctx.deployment!.paymentRouter, amount)).wait();
  await (await router(h, wallet).getFunction('deposit')(amount)).wait();
  await indexUntilCaughtUp(h.ctx);
}

export const routerFor = router;
export const coinFor = coin;

export interface SeededVideo {
  id: string;
  creatorUser: TestUser;
  creatorWallet: Wallet;
  creatorProfileId: string;
}

/** Creates a creator (with linked wallet) and a published, COMPLETED video backed by the HLS fixture. */
export async function seedVideo(
  h: Harness,
  options: { priceStrm?: string; published?: boolean; title?: string; category?: string; tags?: string[]; creator?: SeededVideo; linkCreatorWallet?: boolean } = {},
): Promise<SeededVideo> {
  let creatorUser: TestUser;
  let creatorWallet: Wallet;
  let profileId: string;
  if (options.creator) {
    ({ creatorUser, creatorWallet, creatorProfileId: profileId } = options.creator);
  } else {
    creatorUser = await registerUser(h);
    creatorWallet = await newWallet(h);
    if (options.linkCreatorWallet !== false) await linkWallet(h, creatorUser, creatorWallet);
    const created = await authed(h, creatorUser).post('/api/v1/creator/profile').send({ channelName: `Channel ${uniq('c')}` });
    if (created.status !== 201) throw new Error(`creator profile failed ${JSON.stringify(created.body)}`);
    profileId = (await h.ctx.prisma.creatorProfile.findUniqueOrThrow({ where: { userId: creatorUser.id } })).id;
  }
  const video = await h.ctx.prisma.video.create({
    data: {
      title: options.title ?? `Video ${uniq('v')}`,
      description: 'A seeded test video',
      creatorId: profileId,
      originalFilePath: path.join(inject('fixtureDir'), 'source.mp4'),
      priceSTRM: options.priceStrm ?? '5',
      category: options.category ?? 'Education',
      tags: options.tags ?? ['test'],
      processingStatus: 'COMPLETED',
      transcodeProgress: 100,
      durationSeconds: 24,
      isPublished: options.published ?? true,
    },
  });
  const dest = path.join(h.hlsDir, video.id);
  fs.cpSync(inject('fixtureDir'), dest, { recursive: true, filter: (src) => !src.endsWith('source.mp4') });
  await h.ctx.prisma.video.update({
    where: { id: video.id },
    data: { hlsManifestPath: path.join(dest, 'master.m3u8'), thumbnailPath: path.join(dest, 'thumbnail.jpg') },
  });
  return { id: video.id, creatorUser, creatorWallet, creatorProfileId: profileId };
}

export interface Viewer {
  user: TestUser;
  wallet: Wallet;
}

/** A viewer with a linked wallet and `strm` deposited in escrow (indexed). */
export async function seedViewer(h: Harness, strm = '10'): Promise<Viewer> {
  const user = await registerUser(h);
  const wallet = await newWallet(h);
  await linkWallet(h, user, wallet);
  // The welcome bonus may be queued; keep tests deterministic by not relying on it.
  if (Number(strm) > 0) await fundAndDeposit(h, wallet, strm);
  else await indexUntilCaughtUp(h.ctx);
  return { user, wallet };
}

export async function passwordHash(password: string): Promise<string> {
  return bcrypt.hash(password, 4);
}

export async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, timeoutMs = 15_000, intervalMs = 100): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
