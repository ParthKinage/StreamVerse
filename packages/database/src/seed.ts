/**
 * Idempotent seed: 1 admin, 2 creators, 3 viewers and 6 videos generated with FFmpeg's `testsrc`
 * (no copyrighted media). Safe to run repeatedly.
 *
 * Wallets: on the local chain (CHAIN_ID=31337) the creators and admin get well-known Hardhat accounts #1, #2 and #0
 * so earnings can be claimed in development. On any other chain no wallets are assigned.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { HDNodeWallet, Mnemonic } from 'ethers';
import { disconnectPrisma, getPrisma } from './index';

function findEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return void dotenv.config({ path: candidate });
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
function hardhatAddress(index: number): string {
  const wallet = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(HARDHAT_MNEMONIC), `m/44'/60'/0'/0/${index}`);
  return wallet.address.toLowerCase();
}

export const SEED_PASSWORD = 'Password123!';

const USERS = [
  { id: 'seed-user-admin', email: 'admin@streamverse.test', username: 'admin', role: 'ADMIN', wallet: 0 },
  { id: 'seed-user-creator1', email: 'creator1@streamverse.test', username: 'pixelpilot', role: 'CREATOR', wallet: 1 },
  { id: 'seed-user-creator2', email: 'creator2@streamverse.test', username: 'soundwave', role: 'CREATOR', wallet: 2 },
  { id: 'seed-user-viewer1', email: 'viewer1@streamverse.test', username: 'viewer_one', role: 'USER', wallet: -1 },
  { id: 'seed-user-viewer2', email: 'viewer2@streamverse.test', username: 'viewer_two', role: 'USER', wallet: -1 },
  { id: 'seed-user-viewer3', email: 'viewer3@streamverse.test', username: 'viewer_three', role: 'USER', wallet: -1 },
] as const;

const CREATORS = [
  { id: 'seed-creator-1', userId: 'seed-user-creator1', channelName: 'Pixel Pilot', bio: 'Test-pattern tutorials and tech demos.' },
  { id: 'seed-creator-2', userId: 'seed-user-creator2', channelName: 'Sound Wave', bio: 'Music visualisations and audio experiments.' },
] as const;

const VIDEOS = [
  { id: 'seed-video-1', creatorId: 'seed-creator-1', title: 'Intro to Test Patterns', category: 'Education', tags: ['intro', 'video', 'basics'], price: '20', seconds: 20, pattern: 'testsrc' },
  { id: 'seed-video-2', creatorId: 'seed-creator-1', title: 'Colour Bars Explained', category: 'Education', tags: ['colour', 'video', 'broadcast'], price: '15', seconds: 24, pattern: 'smptebars' },
  { id: 'seed-video-3', creatorId: 'seed-creator-1', title: 'Free Sample: Bouncing Pattern', category: 'Tech', tags: ['sample', 'free'], price: '0', seconds: 15, pattern: 'testsrc2' },
  { id: 'seed-video-4', creatorId: 'seed-creator-2', title: 'Sine Sweep Visualised', category: 'Music', tags: ['audio', 'sine', 'music'], price: '30', seconds: 30, pattern: 'testsrc', audio: true },
  { id: 'seed-video-5', creatorId: 'seed-creator-2', title: 'Rhythm of Colour', category: 'Art', tags: ['colour', 'art', 'rhythm'], price: '25', seconds: 25, pattern: 'rgbtestsrc', audio: true },
  { id: 'seed-video-6', creatorId: 'seed-creator-2', title: 'Gradients in Motion', category: 'Art', tags: ['gradient', 'motion', 'art'], price: '10', seconds: 18, pattern: 'gradients' },
] as const;

function ffmpeg(bin: string, args: string[]): void {
  const res = spawnSync(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`ffmpeg failed: ${res.stderr?.slice(-400) ?? res.error?.message}`);
}

function generateMedia(bin: string, uploadDir: string, hlsDir: string, v: (typeof VIDEOS)[number]): { source: string; manifest: string; thumb: string } {
  const outDir = path.join(hlsDir, v.id);
  const source = path.join(uploadDir, `${v.id}.mp4`);
  const manifest = path.join(outDir, 'master.m3u8');
  const thumb = path.join(outDir, 'thumbnail.jpg');
  if (fs.existsSync(manifest) && fs.existsSync(thumb) && fs.existsSync(source)) return { source, manifest, thumb };
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  const hasAudio = 'audio' in v && v.audio;
  const input = ['-f', 'lavfi', '-i', `${v.pattern}=size=640x360:rate=25`];
  const audioIn = hasAudio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'] : [];
  const common = ['-y', '-hide_banner', '-loglevel', 'error', ...input, ...audioIn, '-t', String(v.seconds)];
  ffmpeg(bin, [...common, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(hasAudio ? ['-c:a', 'aac'] : []), source]);
  // Single 360p rendition plus a master playlist, same layout the video worker produces.
  const rendDir = path.join(outDir, '360p');
  fs.mkdirSync(rendDir, { recursive: true });
  ffmpeg(bin, [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', source,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '100', '-keyint_min', '100', '-sc_threshold', '0',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '96k'] : ['-an']),
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(rendDir, 'seg_%03d.ts'), path.join(rendDir, 'index.m3u8'),
  ]);
  fs.writeFileSync(
    manifest,
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,NAME="360p"\n360p/index.m3u8\n',
  );
  ffmpeg(bin, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(1, Math.floor(v.seconds * 0.1))), '-i', source, '-frames:v', '1', thumb]);
  return { source, manifest, thumb };
}

/** Relative media folders resolve against the repo root (the folder whose package.json has "workspaces"), so the API, worker and seed all agree no matter which workspace they run from. */
function resolveFromRepoRoot(p: string): string {
  if (path.isAbsolute(p)) return p;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { workspaces?: unknown };
      if (pkg.workspaces) return path.resolve(dir, p);
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(p);
}

async function main(): Promise<void> {
  findEnv();
  const prisma = getPrisma();
  const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
  const uploadDir = resolveFromRepoRoot(process.env.UPLOAD_DIR || './uploads');
  const hlsDir = resolveFromRepoRoot(process.env.HLS_OUTPUT_DIR || './hls-output');
  const local = (process.env.CHAIN_ID ?? '80002') === '31337';
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  for (const u of USERS) {
    const walletAddress = local && u.wallet >= 0 ? hardhatAddress(u.wallet) : null;
    await prisma.user.upsert({
      where: { id: u.id },
      update: { email: u.email, username: u.username, role: u.role, walletAddress },
      create: { id: u.id, email: u.email, username: u.username, role: u.role, walletAddress, passwordHash },
    });
  }
  for (const c of CREATORS) {
    await prisma.creatorProfile.upsert({
      where: { id: c.id },
      update: { channelName: c.channelName, bio: c.bio },
      create: { id: c.id, userId: c.userId, channelName: c.channelName, bio: c.bio },
    });
  }
  for (const v of VIDEOS) {
    const media = generateMedia(ffmpegBin, uploadDir, hlsDir, v);
    const data = {
      title: v.title,
      description: `${v.title}. Generated test media for the StreamVerse demo.`,
      creatorId: v.creatorId,
      originalFilePath: media.source,
      hlsManifestPath: media.manifest,
      thumbnailPath: media.thumb,
      durationSeconds: v.seconds,
      priceSTRM: v.price,
      category: v.category,
      tags: [...v.tags],
      processingStatus: 'COMPLETED' as const,
      transcodeProgress: 100,
      isPublished: true,
    };
    await prisma.video.upsert({ where: { id: v.id }, update: data, create: { id: v.id, ...data } });
  }
  process.stdout.write(`Seeded ${USERS.length} users, ${CREATORS.length} creators, ${VIDEOS.length} videos. Password for all: ${SEED_PASSWORD}\n`);
}

main()
  .catch((err) => {
    process.stderr.write(`Seed failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
