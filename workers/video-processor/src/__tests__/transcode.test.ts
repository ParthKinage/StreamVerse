import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { probe } from '../ffmpeg';
import { buildLadder, buildMasterPlaylist, renditionSize, transcode } from '../transcode';
import { startWorker } from '../worker';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';
let tmp: string;
let withAudio: string;
let silent: string;

function ffmpeg(args: string[]): void {
  const res = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(res.stderr);
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tesor-worker-'));
  withAudio = path.join(tmp, 'with audio.mp4'); // a space in the name proves arguments are not shell-parsed
  silent = path.join(tmp, 'silent.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', withAudio]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const deps = { ffmpegPath: FFMPEG, ffprobePath: FFPROBE };

describe('ladder', () => {
  it('always has 360p and 720p, adds 1080p only for 1080p+ sources, never upscales', () => {
    expect(buildLadder(180).map((r) => r.name)).toEqual(['360p', '720p']);
    expect(buildLadder(720).map((r) => r.name)).toEqual(['360p', '720p']);
    expect(buildLadder(1079).map((r) => r.name)).toEqual(['360p', '720p']);
    expect(buildLadder(1080).map((r) => r.name)).toEqual(['360p', '720p', '1080p']);
    const src = { durationSeconds: 10, width: 1280, height: 720, hasAudio: true };
    expect(renditionSize(src, buildLadder(720)[0]!)).toEqual({ width: 640, height: 360 });
    expect(renditionSize({ ...src, width: 320, height: 180 }, buildLadder(180)[1]!)).toEqual({ width: 320, height: 180 });
  });

  it('writes a master playlist that lists every rendition', () => {
    const [a, b] = buildLadder(720);
    const text = buildMasterPlaylist([{ spec: a!, width: 640, height: 360 }, { spec: b!, width: 1280, height: 720 }]);
    expect(text.startsWith('#EXTM3U\n')).toBe(true);
    expect(text).toContain('RESOLUTION=640x360');
    expect(text).toContain('360p/index.m3u8');
    expect(text).toContain('720p/index.m3u8');
  });
});

describe('transcode', () => {
  it('produces a valid HLS ladder, segments, thumbnail and duration from a 10 s clip', async () => {
    const out = path.join(tmp, 'out', 'v1');
    const progress: number[] = [];
    const result = await transcode({ videoId: 'v1', inputPath: withAudio, outputDir: out }, { ...deps, onProgress: (p) => void progress.push(p) });

    expect(result.renditions).toEqual(['360p', '720p']);
    expect(result.durationSeconds).toBeGreaterThan(9.5);
    expect(result.durationSeconds).toBeLessThan(10.6);
    expect(result.manifestPath).toBe(path.join(out, 'master.m3u8'));
    const master = fs.readFileSync(result.manifestPath, 'utf8');
    expect(master).toContain('360p/index.m3u8');
    expect(master).toContain('720p/index.m3u8');

    for (const r of result.renditions) {
      const playlist = fs.readFileSync(path.join(out, r, 'index.m3u8'), 'utf8');
      expect(playlist).toContain('#EXT-X-ENDLIST');
      expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
      const segs = fs.readdirSync(path.join(out, r)).filter((f) => f.endsWith('.ts'));
      expect(segs.length).toBe(3); // 10 s in 4 s segments
      const info = await probe(FFPROBE, path.join(out, r, segs[0]!));
      expect(info.hasAudio).toBe(true);
      expect(info.height).toBe(r === '360p' ? 360 : 720);
    }
    expect(fs.statSync(result.thumbnailPath).size).toBeGreaterThan(500);
    // progress is monotonic, bounded and ends at 100
    expect(progress.length).toBeGreaterThan(2);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(progress.at(-1)).toBe(100);
    expect(progress.slice(0, -1).every((p) => p < 100)).toBe(true);
    expect(fs.readdirSync(path.dirname(out)).filter((n) => n.includes('.partial-'))).toEqual([]);
  });

  it('handles a source without an audio track and does not upscale a 360p source', async () => {
    const out = path.join(tmp, 'out', 'v2');
    const result = await transcode({ videoId: 'v2', inputPath: silent, outputDir: out }, deps);
    const seg = fs.readdirSync(path.join(out, '720p')).find((f) => f.endsWith('.ts'))!;
    const info = await probe(FFPROBE, path.join(out, '720p', seg));
    expect(info.hasAudio).toBe(false);
    expect(info.height).toBe(360);
    expect(result.renditions).toEqual(['360p', '720p']);
  });

  it('fails cleanly on a corrupt file and leaves no output directory', async () => {
    const bad = path.join(tmp, 'corrupt.mp4');
    fs.writeFileSync(bad, Buffer.from('definitely not a video, just some bytes'.repeat(20)));
    const out = path.join(tmp, 'out', 'v3');
    await expect(transcode({ videoId: 'v3', inputPath: bad, outputDir: out }, deps)).rejects.toThrow(/corrupt|not a supported|no video/i);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'out')) ? fs.readdirSync(path.join(tmp, 'out')).filter((n) => n.startsWith('v3')) : []).toEqual([]);
  });

  it('removes partial output when FFmpeg fails mid-way (truncated file)', async () => {
    const truncated = path.join(tmp, 'truncated.mp4');
    const buf = fs.readFileSync(withAudio);
    fs.writeFileSync(truncated, buf.subarray(0, Math.floor(buf.length / 3)));
    const out = path.join(tmp, 'out', 'v4');
    await expect(transcode({ videoId: 'v4', inputPath: truncated, outputDir: out }, deps)).rejects.toThrow();
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.readdirSync(path.join(tmp, 'out')).filter((n) => n.startsWith('v4'))).toEqual([]);
  });

  it('fails when the input is missing, and can be cancelled', async () => {
    await expect(transcode({ videoId: 'v5', inputPath: path.join(tmp, 'nope.mp4'), outputDir: path.join(tmp, 'out', 'v5') }, deps)).rejects.toThrow(/missing/);
    const ctl = new AbortController();
    const p = transcode({ videoId: 'v6', inputPath: withAudio, outputDir: path.join(tmp, 'out', 'v6') }, { ...deps, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 150);
    await expect(p).rejects.toThrow(/cancel/i);
    expect(fs.existsSync(path.join(tmp, 'out', 'v6'))).toBe(false);
  });
});

describe('queue worker', () => {
  const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/14';

  it('consumes a transcode job, reports progress and returns the result', async () => {
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    await connection.flushdb();
    const queue = new Queue('transcode', { connection, defaultJobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 100 } } });
    const events = new QueueEvents('transcode', { connection: connection.duplicate() });
    await events.waitUntilReady();
    const handle = startWorker(loadConfig({ REDIS_URL: redisUrl, HLS_OUTPUT_DIR: path.join(tmp, 'hls'), FFMPEG_PATH: FFMPEG, FFPROBE_PATH: FFPROBE }), () => undefined);
    try {
      const seen: number[] = [];
      events.on('progress', ({ data }) => seen.push((data as { percent: number }).percent));
      const out = path.join(tmp, 'hls', 'q1');
      const job = await queue.add('transcode', { videoId: 'q1', inputPath: silent, outputDir: out }, { jobId: 'transcode-q1' });
      const result = (await job.waitUntilFinished(events, 90_000)) as { renditions: string[]; manifestPath: string };
      expect(result.renditions).toEqual(['360p', '720p']);
      expect(fs.existsSync(result.manifestPath)).toBe(true);
      expect(seen.length).toBeGreaterThan(0);

      // a corrupt source fails on the first attempt (no pointless retry) with a readable reason
      const bad = path.join(tmp, 'queue-bad.mp4');
      fs.writeFileSync(bad, 'garbage');
      const failing = await queue.add('transcode', { videoId: 'q2', inputPath: bad, outputDir: path.join(tmp, 'hls', 'q2') }, { jobId: 'transcode-q2' });
      await expect(failing.waitUntilFinished(events, 30_000)).rejects.toThrow(/corrupt|not a supported|no video/i);
      expect((await queue.getJob('transcode-q2'))?.attemptsMade).toBe(1);
      expect(fs.existsSync(path.join(tmp, 'hls', 'q2'))).toBe(false);
    } finally {
      await handle.close();
      await events.close();
      await queue.close();
      await connection.quit();
    }
  });
});
