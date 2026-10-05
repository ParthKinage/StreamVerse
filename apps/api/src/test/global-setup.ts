import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { startLocalChain, type LocalChain } from '@tesor_gp/blockchain/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrl: string;
    redisUrl: string;
    fixtureDir: string;
    chain: {
      rpcUrl: string;
      chainId: number;
      streamCoin: string;
      paymentRouter: string;
      deploymentBlock: number;
      deployerKey: string;
      feeBps: number;
      withdrawDelaySec: number;
    };
  }
}

const MIGRATIONS = path.resolve(__dirname, '../../../../packages/database/prisma/migrations');

function baseDbUrl(): URL {
  return new URL(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/tesor_gp?schema=public');
}

function ffmpeg(args: string[]): void {
  const res = spawnSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`ffmpeg failed: ${res.stderr}`);
}

/** A tiny 24 s 360p HLS rendition (6 segments of 4 s) used by playback and billing tests. */
function buildFixture(dir: string): void {
  const rend = path.join(dir, '360p');
  fs.mkdirSync(rend, { recursive: true });
  const source = path.join(dir, 'source.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-t', '24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  ffmpeg([
    '-i', source, '-c:v', 'libx264', '-g', '100', '-keyint_min', '100', '-sc_threshold', '0', '-an',
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(rend, 'seg_%03d.ts'), path.join(rend, 'index.m3u8'),
  ]);
  fs.writeFileSync(path.join(dir, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x180\n360p/index.m3u8\n');
  ffmpeg(['-ss', '2', '-i', source, '-frames:v', '1', path.join(dir, 'thumbnail.jpg')]);
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
  const url = baseDbUrl();
  const dbName = `tesor_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: new URL('/postgres', url).toString().replace(/\?.*$/, '') });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const testUrl = new URL(url.toString());
  testUrl.pathname = `/${dbName}`;
  const client = new pg.Client({ connectionString: testUrl.toString().replace(/\?.*$/, '') });
  await client.connect();
  for (const dir of fs.readdirSync(MIGRATIONS).filter((d) => fs.statSync(path.join(MIGRATIONS, d)).isDirectory()).sort()) {
    await client.query(fs.readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
  }
  await client.end();

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesor-fixture-'));
  buildFixture(fixtureDir);

  const chain: LocalChain = await startLocalChain();

  project.provide('dbUrl', `${testUrl.toString().replace(/\?.*$/, '')}?schema=public`);
  project.provide('redisUrl', redisUrl);
  project.provide('fixtureDir', fixtureDir);
  project.provide('chain', {
    rpcUrl: chain.rpcUrl,
    chainId: chain.chainId,
    streamCoin: chain.streamCoin,
    paymentRouter: chain.paymentRouter,
    deploymentBlock: chain.deploymentBlock,
    deployerKey: chain.deployer.privateKey,
    feeBps: chain.feeBps,
    withdrawDelaySec: chain.withdrawDelaySec,
  });

  return async () => {
    await chain.stop();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    const a = new pg.Client({ connectionString: new URL('/postgres', url).toString().replace(/\?.*$/, '') });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await a.end();
  };
}
