import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const ZERO_KEY = '0x' + '0'.repeat(64);
// Well-known Hardhat account #0. Local development chain only; never valid in production.
const HARDHAT_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// Public, well-known seed for built-in wallets on the local development chain only; never valid anywhere else.
export const DEV_WALLET_SEED = '0x' + '5a'.repeat(32);
const truthy = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || (typeof v === 'string' && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

function loadDotenv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

const num = (def: number) => z.coerce.number().int().positive().default(def);
/** A 32-byte hex key. MetaMask exports keys without "0x"; both spellings are accepted and normalised to "0x…". */
const hexKey = z
  .string()
  .trim()
  .transform((k) => (/^[0-9a-fA-F]{64}$/.test(k) ? `0x${k}` : k))
  .pipe(z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex key (64 hex characters, with or without 0x)'));
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: num(4000),
    API_BASE_URL: z.string().url().default('http://localhost:4000'),
    WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    JWT_SECRET: z.string().min(16),
    COOKIE_SECRET: z.string().min(16),
    PLAYBACK_SIGNING_SECRET: z.string().min(16),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('7d'),
    /** 'bank' = simulated bank wallet, no crypto (default for the prototype). 'chain' = STRM tokens on a blockchain. */
    PAYMENTS_MODE: z.enum(['bank', 'chain']).default('bank'),
    /**
     * Chain mode only. 'managed' = every account gets a built-in blockchain wallet and the platform pays the gas.
     * 'external' = users link their own browser wallet (MetaMask) and pay their own gas.
     */
    WALLET_MODE: z.enum(['external', 'managed']).default('managed'),
    /** Secret that every built-in wallet address is derived from. Losing or changing it orphans those wallets. */
    WALLET_MASTER_SEED: hexKey.optional(),
    /** Smallest creator payout the platform will send on-chain (each payout costs the platform gas). */
    MIN_PAYOUT_STRM: num(1),
    /** Most coins one account can buy in 24 hours with the demo bank (built-in wallets). */
    TOPUP_DAILY_LIMIT_STRM: num(10000),
    /** Gas balance (in thousandths of the native coin) below which the admin page warns that the platform wallet is low. */
    /** Warn below this many thousandths of the native coin (150 = 0.15): roughly what a full batch must hold up front. */
    LOW_GAS_MILLI: num(150),
    /** Largest block range per eth_getLogs request; the indexer steps down automatically when the RPC refuses it. */
    INDEXER_MAX_BLOCK_RANGE: z.coerce.number().int().min(1).max(100_000).default(2000),
    /**
     * When the app is pointed at a different ledger (bank to chain, or a newly deployed contract), balances and
     * payments recorded for the old one no longer mean anything. true = clear them automatically at startup.
     */
    LEDGER_RESET_ON_CHANGE: truthy.default(false),
    /** Platform cut in basis points, bank mode only (chain mode reads the fee from the contract). */
    /** How long a purchase keeps a video unlocked. */
    ACCESS_HOURS: z.coerce.number().int().min(1).max(8760).default(48),
    PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(5000).default(0),
    CURRENCY_CODE: z.string().min(1).max(8).default('INR'),
    CURRENCY_SYMBOL: z.string().min(1).max(4).default('₹'),
    /** Limits for one "add money" action, in whole currency units. */
    BANK_MIN_TOPUP: num(10),
    BANK_MAX_TOPUP: num(50000),
    CHAIN_ID: z.coerce.number().int().positive().default(80002),
    RPC_URL: z.string().url().optional(),
    POLYGON_AMOY_RPC_URL: z.string().url().default('https://rpc-amoy.polygon.technology'),
    /**
     * RPC URL handed to browsers (only used to add the network to a linked wallet). The server's own RPC URL often
     * contains a private API key, so it is never sent to the browser.
     */
    PUBLIC_RPC_URL: z.string().url().optional(),
    STREAMCOIN_TOKEN_ADDRESS: address.optional(),
    PAYMENT_ROUTER_ADDRESS: address.optional(),
    SETTLEMENT_RELAYER_PRIVATE_KEY: hexKey.optional(),
    EXPLORER_URL: z.string().url().default('https://amoy.polygonscan.com'),
    CONFIRMATIONS: z.coerce.number().int().nonnegative().optional(),
    SETTLE_BATCH_SIZE: num(25),
    SETTLE_MAX_ATTEMPTS: num(8),
    /**
     * How long the relayer waits before writing to the blockchain, so that payments and purchases made close together
     * share one transaction (and one gas fee). Viewers are not kept waiting: a video unlocks the moment it is bought.
     */
    BATCH_WINDOW_MS: z.coerce.number().int().min(0).max(60_000).default(2000),
    WELCOME_BONUS_STRM: num(50),
    STORAGE_PROVIDER: z.enum(['local', 's3', 'ipfs']).default('local'),
    /** Object storage (STORAGE_PROVIDER=s3): any S3-compatible service. Required together when s3 is selected. */
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().min(1).optional(),
    S3_BUCKET: z.string().min(1).optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_FORCE_PATH_STYLE: truthy.default(false),
    /** How long a presigned upload URL stays valid. */
    UPLOAD_URL_TTL_SEC: z.coerce.number().int().min(60).max(24 * 3600).default(3600),
    /** How often the API checks that every playable video still has its files (0 disables the check). */
    MEDIA_RECONCILE_EVERY_MIN: z.coerce.number().int().min(0).default(60),
    UPLOAD_DIR: z.string().default('./uploads'),
    HLS_OUTPUT_DIR: z.string().default('./hls-output'),
    FFMPEG_PATH: z.string().default('ffmpeg'),
    FFPROBE_PATH: z.string().default('ffprobe'),
    MAX_UPLOAD_MB: num(1024),
    HEARTBEAT_INTERVAL_SEC: num(10),
    PLAYBACK_TOKEN_TTL_SEC: num(30),
    SESSION_TIMEOUT_SEC: num(45),
    /** Recommendation service. When unset, recommendations use the trending fallback at once (no network call). */
    AI_SERVICE_URL: z.string().url().optional(),
    AI_TIMEOUT_MS: num(800),
    AI_FALLBACK_MODE: z.string().default('trending'),
    RATE_LIMIT_MAX: num(300),
    AUTH_RATE_LIMIT_MAX: num(30),
    BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(14).default(10),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_PROVIDER === 'ipfs') {
      ctx.addIssue({ code: 'custom', path: ['STORAGE_PROVIDER'], message: 'storage provider "ipfs" is not implemented; use "local" or "s3"' });
    }
    if (env.STORAGE_PROVIDER === 's3') {
      for (const key of ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required when STORAGE_PROVIDER=s3' });
      }
    }
    if (env.NODE_ENV === 'production' && env.PAYMENTS_MODE === 'chain') {
      const key = env.SETTLEMENT_RELAYER_PRIVATE_KEY;
      if (!key || key.toLowerCase() === ZERO_KEY) {
        ctx.addIssue({
          code: 'custom',
          path: ['SETTLEMENT_RELAYER_PRIVATE_KEY'],
          message: 'a real relayer key is required in production (the all-zero key is rejected)',
        });
      }
      if (env.CHAIN_ID === 31337) {
        ctx.addIssue({ code: 'custom', path: ['CHAIN_ID'], message: 'the local chain id 31337 is not allowed in production' });
      }
    }
    if (env.PAYMENTS_MODE === 'chain' && env.WALLET_MODE === 'managed' && env.CHAIN_ID !== 31337) {
      const seed = env.WALLET_MASTER_SEED?.toLowerCase();
      if (!seed || seed === ZERO_KEY || seed === DEV_WALLET_SEED) {
        ctx.addIssue({
          code: 'custom',
          path: ['WALLET_MASTER_SEED'],
          message: 'a secret 32-byte hex seed is required for built-in wallets (WALLET_MODE=managed) outside the local chain',
        });
      }
    }
  });

export type Env = Omit<z.infer<typeof schema>, 'SETTLEMENT_RELAYER_PRIVATE_KEY' | 'CONFIRMATIONS' | 'RPC_URL' | 'WALLET_MASTER_SEED'> & {
  SETTLEMENT_RELAYER_PRIVATE_KEY: string | undefined;
  WALLET_MASTER_SEED: string | undefined;
  CONFIRMATIONS: number;
  RPC_URL: string;
};

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const e = result.data;
  const local = e.CHAIN_ID === 31337;
  let relayer = e.SETTLEMENT_RELAYER_PRIVATE_KEY;
  if (relayer?.toLowerCase() === ZERO_KEY) relayer = undefined;
  if (!relayer && local) relayer = HARDHAT_KEY;
  return {
    ...e,
    WALLET_MASTER_SEED: e.WALLET_MASTER_SEED ?? (local ? DEV_WALLET_SEED : undefined),
    SETTLEMENT_RELAYER_PRIVATE_KEY: relayer,
    CONFIRMATIONS: e.CONFIRMATIONS ?? (local ? 1 : 3),
    RPC_URL: e.RPC_URL ?? (local ? 'http://127.0.0.1:8545' : e.POLYGON_AMOY_RPC_URL),
  };
}

let cached: Env | undefined;

/** Loads .env, validates, and exits with a readable message on failure. */
export function loadEnv(): Env {
  if (cached) return cached;
  loadDotenv();
  try {
    cached = parseEnv(process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
  return cached;
}
