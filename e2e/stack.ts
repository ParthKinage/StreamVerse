/**
 * Starts the whole platform for end-to-end runs: a private Redis, a temporary Postgres database, a local Hardhat chain
 * (behind a switchable RPC proxy), the AI service, the API (with indexer and settlement worker), the video worker and
 * the Vite dev server with the test wallet enabled. Everything listens on free ports and is torn down afterwards.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { FlakyRpcProxy, hardhatAccount, startLocalChain, type LocalChain } from '@tesor_gp/blockchain/testing';

export const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'packages', 'database', 'prisma', 'migrations');
const LOG_DIR = path.join(__dirname, '.logs');

export const JWT_SECRET = 'e2e-jwt-secret-0123456789';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 90_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // not ready yet
    }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const http200 = (url: string) => async (): Promise<boolean> => (await fetch(url)).ok;

interface Managed {
  name: string;
  child: ChildProcess | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function spawnLogged(name: string, cmd: string, args: string[], env: Record<string, string>, cwd: string): ChildProcess {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const out = fs.openSync(path.join(LOG_DIR, `${name}.log`), 'a');
  return spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', out, out], windowsHide: true });
}

async function kill(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 8000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export interface Stack {
  webUrl: string;
  apiUrl: string;
  chain: LocalChain;
  /** Direct (unproxied) RPC URL, used by the browser test wallet and test code. */
  rpcUrl: string;
  proxy: FlakyRpcProxy;
  dbUrl: string;
  redisUrl: string;
  hlsDir: string;
  /** Creates a funded viewer/creator wallet key (Hardhat account `index`). */
  accountKey(index: number): string;
  restartRedis(): Promise<void>;
  stopAi(): Promise<void>;
  startAi(): Promise<void>;
  /** Simulates the chain node going away (the API's RPC calls fail) or coming back. */
  setChainDown(down: boolean): void;
  pg<T>(sql: string, params?: unknown[]): Promise<T[]>;
  stop(): Promise<void>;
}

function mustExist(file: string, hint: string): void {
  if (!fs.existsSync(file)) throw new Error(`${file} is missing. ${hint}`);
}

export async function startStack(): Promise<Stack> {
  const cleanups: Array<() => Promise<unknown>> = [];
  try {
    return await startStackInner(cleanups);
  } catch (err) {
    for (const c of cleanups.reverse()) await c().catch(() => undefined);
    throw err;
  }
}

async function startStackInner(cleanups: Array<() => Promise<unknown>>): Promise<Stack> {
  mustExist(path.join(ROOT, 'apps', 'api', 'dist', 'index.js'), 'Run "npm run build" first.');
  mustExist(path.join(ROOT, 'workers', 'video-processor', 'dist', 'index.js'), 'Run "npm run build" first.');
  mustExist(path.join(ROOT, 'ai', 'dist', 'index.js'), 'Run "npm run build" first.');
  fs.rmSync(LOG_DIR, { recursive: true, force: true });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'streamverse-e2e-'));
  const hlsDir = path.join(tmp, 'hls');
  const uploadDir = path.join(tmp, 'uploads');
  fs.mkdirSync(hlsDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  const managed: Managed[] = [];

  // ---- Redis (own instance so scenario 10 can restart it) ----
  const redisPort = await freePort();
  const redisUrl = `redis://127.0.0.1:${redisPort}`;
  const redis: Managed = {
    name: 'redis',
    child: undefined,
    async start() {
      this.child = spawnLogged('redis', process.env.REDIS_SERVER_PATH ?? 'redis-server', ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], {}, tmp);
      await waitFor(async () => {
        const s = net.connect(redisPort, '127.0.0.1');
        return new Promise<boolean>((resolve) => {
          s.once('connect', () => (s.destroy(), resolve(true)));
          s.once('error', () => resolve(false));
        });
      }, 'redis', 20_000);
    },
    async stop() {
      await kill(this.child);
    },
  };
  managed.push(redis);
  cleanups.push(() => redis.stop());
  await redis.start();

  // ---- Postgres: temporary database with the migrations applied ----
  const baseUrl = new URL(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/tesor_gp?schema=public');
  const dbName = `streamverse_e2e_${process.pid}_${Date.now()}`;
  const adminConn = new URL(baseUrl.toString());
  adminConn.pathname = '/postgres';
  adminConn.search = '';
  const admin = new pg.Client({ connectionString: adminConn.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  cleanups.push(async () => {
    const a = new pg.Client({ connectionString: adminConn.toString() });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await a.end();
  });
  const dbConn = new URL(baseUrl.toString());
  dbConn.pathname = `/${dbName}`;
  dbConn.search = '';
  const dbUrl = `${dbConn.toString()}?schema=public`;
  const pool = new pg.Pool({ connectionString: dbConn.toString(), max: 4 });
  for (const dir of fs.readdirSync(MIGRATIONS).filter((d) => fs.statSync(path.join(MIGRATIONS, d)).isDirectory()).sort()) {
    await pool.query(fs.readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
  }

  // ---- Chain (+ proxy that can simulate an outage for the API) ----
  const chain = await startLocalChain({ withdrawDelaySec: 900 });
  cleanups.push(() => chain.stop());
  const proxy = new FlakyRpcProxy(chain.rpcUrl);
  const proxyUrl = await proxy.start();
  cleanups.push(() => proxy.stop());

  // ---- AI service ----
  const aiPort = await freePort();
  const ai: Managed = {
    name: 'ai',
    child: undefined,
    async start() {
      this.child = spawnLogged('ai', process.execPath, [path.join(ROOT, 'ai', 'dist', 'index.js')], { AI_PORT: String(aiPort) }, ROOT);
      await waitFor(http200(`http://127.0.0.1:${aiPort}/health`), 'AI service', 30_000);
    },
    async stop() {
      await kill(this.child);
    },
  };
  managed.push(ai);
  cleanups.push(() => ai.stop());
  await ai.start();

  // ---- API ----
  const apiPort = await freePort();
  const webPort = await freePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://localhost:${webPort}`;
  const commonEnv: Record<string, string> = {
    REDIS_URL: redisUrl,
    HLS_OUTPUT_DIR: hlsDir,
    UPLOAD_DIR: uploadDir,
    FFMPEG_PATH: process.env.FFMPEG_PATH ?? 'ffmpeg',
    FFPROBE_PATH: process.env.FFPROBE_PATH ?? 'ffprobe',
  };
  const api: Managed = {
    name: 'api',
    child: undefined,
    async start() {
      this.child = spawnLogged(
        'api',
        process.execPath,
        [path.join(ROOT, 'apps', 'api', 'dist', 'index.js')],
        {
          ...commonEnv,
          NODE_ENV: 'development',
          PORT: String(apiPort),
          API_BASE_URL: apiUrl,
          WEB_BASE_URL: webUrl,
          DATABASE_URL: dbUrl,
          JWT_SECRET,
          COOKIE_SECRET: 'e2e-cookie-secret-0123456789',
          PLAYBACK_SIGNING_SECRET: 'e2e-playback-secret-0123456789',
          PAYMENTS_MODE: 'chain',
          CHAIN_ID: '31337',
          RPC_URL: proxyUrl,
          STREAMCOIN_TOKEN_ADDRESS: chain.streamCoin,
          PAYMENT_ROUTER_ADDRESS: chain.paymentRouter,
          DEPLOYMENT_BLOCK: String(chain.deploymentBlock),
          SETTLEMENT_RELAYER_PRIVATE_KEY: chain.deployer.privateKey,
          CONFIRMATIONS: '1',
          AI_SERVICE_URL: `http://127.0.0.1:${aiPort}`,
          AI_TIMEOUT_MS: '800',
          RATE_LIMIT_MAX: '100000',
          AUTH_RATE_LIMIT_MAX: '100000',
          BCRYPT_ROUNDS: '4',
          LOG_LEVEL: 'warn',
          WELCOME_BONUS_STRM: '50',
          SETTLE_MAX_ATTEMPTS: '12',
        },
        ROOT,
      );
      await waitFor(http200(`${apiUrl}/health`), 'API', 60_000);
    },
    async stop() {
      await kill(this.child);
    },
  };
  managed.push(api);
  cleanups.push(() => api.stop());
  await api.start();

  // ---- Video worker ----
  const worker: Managed = {
    name: 'worker',
    child: undefined,
    async start() {
      this.child = spawnLogged('worker', process.execPath, [path.join(ROOT, 'workers', 'video-processor', 'dist', 'index.js')], commonEnv, ROOT);
    },
    async stop() {
      await kill(this.child);
    },
  };
  managed.push(worker);
  cleanups.push(() => worker.stop());
  await worker.start();

  // ---- Web (Vite dev server, test wallet enabled) ----
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  mustExist(viteBin, 'Run "npm install" first.');
  const web: Managed = {
    name: 'web',
    child: undefined,
    async start() {
      this.child = spawnLogged('web', process.execPath, [viteBin, '--port', String(webPort), '--strictPort', '--host', 'localhost'], { VITE_E2E: '1', VITE_PROXY_TARGET: apiUrl }, path.join(ROOT, 'apps', 'web'));
      await waitFor(http200(webUrl), 'web dev server', 90_000);
    },
    async stop() {
      await kill(this.child);
    },
  };
  managed.push(web);
  cleanups.push(() => web.stop());
  await web.start();

  const stack: Stack = {
    webUrl,
    apiUrl,
    chain,
    rpcUrl: chain.rpcUrl,
    proxy,
    dbUrl,
    redisUrl,
    hlsDir,
    accountKey: (index) => hardhatAccount(index).privateKey,
    async restartRedis() {
      await redis.stop();
      await redis.start();
    },
    stopAi: () => ai.stop(),
    startAi: () => ai.start(),
    setChainDown(down) {
      proxy.down = down;
    },
    async pg<T>(sql: string, params: unknown[] = []) {
      return (await pool.query(sql, params)).rows as T[];
    },
    async stop() {
      for (const m of [...managed].reverse()) await m.stop().catch(() => undefined);
      await proxy.stop().catch(() => undefined);
      await chain.stop().catch(() => undefined);
      await pool.end().catch(() => undefined);
      const a = new pg.Client({ connectionString: adminConn.toString() });
      try {
        await a.connect();
        await a.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } catch {
        // best effort
      } finally {
        await a.end().catch(() => undefined);
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
  return stack;
}

/** Makes a short test clip with a video and an audio track. */
export function makeClip(file: string, seconds: number, size = '320x180'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const res = spawnSync(
    process.env.FFMPEG_PATH ?? 'ffmpeg',
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=25`, '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`ffmpeg failed: ${res.stderr}`);
}
