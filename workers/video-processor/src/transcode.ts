import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { MediaError, probe, runFfmpeg, type ProbeInfo } from './ffmpeg';

export const SEGMENT_SECONDS = 4;

export interface TranscodeJobData {
  videoId: string;
  /** Local file path, or the object key of the original when `storage` is "s3". */
  inputPath: string;
  /** Local output folder, or the key prefix (`hls/<videoId>/`) when `storage` is "s3". */
  outputDir: string;
  storage?: 'local' | 's3';
}
export interface TranscodeStats {
  /** Wall-clock seconds for the whole job. */
  seconds: number;
  /** Highest resident memory of any single FFmpeg run, in MiB (from `-benchmark`), when FFmpeg reported it. */
  peakRssMiB: number | null;
}
export interface TranscodeJobResult {
  manifestPath: string;
  thumbnailPath: string;
  durationSeconds: number;
  renditions: string[];
  stats?: TranscodeStats;
}

export interface RenditionSpec {
  name: string;
  height: number;
  videoKbps: number;
  audioKbps: number;
}

const RENDITIONS: RenditionSpec[] = [
  { name: '360p', height: 360, videoKbps: 800, audioKbps: 96 },
  { name: '480p', height: 480, videoKbps: 1400, audioKbps: 128 },
  { name: '720p', height: 720, videoKbps: 2500, audioKbps: 128 },
  { name: '1080p', height: 1080, videoKbps: 5000, audioKbps: 128 },
];
export const RENDITION_NAMES = RENDITIONS.map((r) => r.name);
export const DEFAULT_LADDER = '360p,720p,1080p';

/** Parses TRANSCODE_LADDER ("480p" or "360p,720p,1080p") into rendition specs, lowest first. */
export function parseLadder(spec: string): RenditionSpec[] {
  const names = [...new Set(spec.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean))];
  const unknown = names.filter((n) => !RENDITION_NAMES.includes(n));
  if (!names.length || unknown.length) throw new Error(`TRANSCODE_LADDER must list some of ${RENDITION_NAMES.join(', ')}${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}`);
  return RENDITIONS.filter((r) => names.includes(r.name));
}

/** Renditions up to 720p always (never upscaled beyond the source); 1080p only when the source is at least 1080 lines. */
export function buildLadder(sourceHeight: number, ladder: RenditionSpec[] = parseLadder(DEFAULT_LADDER)): RenditionSpec[] {
  return ladder.filter((r) => r.height <= 720 || sourceHeight >= r.height);
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

export function renditionSize(source: ProbeInfo, spec: RenditionSpec): { width: number; height: number } {
  const height = even(Math.min(spec.height, source.height));
  return { width: even((source.width * height) / source.height), height };
}

export function buildMasterPlaylist(entries: Array<{ spec: RenditionSpec; width: number; height: number }>): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const e of entries) {
    const bandwidth = Math.round((e.spec.videoKbps + e.spec.audioKbps) * 1000 * 1.1);
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${e.width}x${e.height},CODECS="avc1.4d401f,mp4a.40.2"`, `${e.spec.name}/index.m3u8`);
  }
  return `${lines.join('\n')}\n`;
}

export interface TranscodeDeps {
  ffmpegPath: string;
  ffprobePath: string;
  /** Renditions to produce; defaults to DEFAULT_LADDER. */
  ladder?: RenditionSpec[];
  /** FFmpeg `-threads`; set it on small hosts so one encode cannot take every core (and the memory that comes with them). */
  threads?: number;
  onProgress?: (percent: number) => void | Promise<void>;
  signal?: AbortSignal;
}

function renditionArgs(input: string, outDir: string, spec: RenditionSpec, size: { height: number }, hasAudio: boolean, threads?: number): string[] {
  const args = ['-i', input, '-map', '0:v:0'];
  if (threads) args.push('-threads', String(threads));
  if (hasAudio) args.push('-map', '0:a:0');
  args.push(
    '-vf', `scale=-2:${size.height}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
    '-b:v', `${spec.videoKbps}k`, '-maxrate', `${Math.round(spec.videoKbps * 1.2)}k`, '-bufsize', `${spec.videoKbps * 2}k`,
    // Keyframes on a fixed 4 s grid so every segment starts with an IDR frame regardless of the source frame rate.
    '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`, '-sc_threshold', '0',
  );
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', `${spec.audioKbps}k`, '-ac', '2');
  else args.push('-an');
  args.push(
    '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(outDir, 'seg_%03d.ts'), path.join(outDir, 'index.m3u8'),
  );
  return args;
}

/**
 * Transcodes `inputPath` into `<outputDir>/{master.m3u8, <rendition>/index.m3u8, thumbnail.jpg}`.
 * Everything is written to a sibling temp directory and renamed into place at the end, so a failure never leaves
 * a half-written output directory behind.
 */
export async function transcode(data: TranscodeJobData, deps: TranscodeDeps): Promise<TranscodeJobResult> {
  const { inputPath, outputDir } = data;
  if (!fs.existsSync(inputPath)) throw new MediaError('The uploaded file is missing from storage', true);
  const started = Date.now();
  let peakRssKiB: number | null = null;
  const track = (rss: number | undefined): void => {
    if (rss !== undefined) peakRssKiB = Math.max(peakRssKiB ?? 0, rss);
  };
  const info = await probe(deps.ffprobePath, inputPath, deps.signal);
  const ladder = buildLadder(info.height, deps.ladder);
  const temp = `${outputDir}.partial-${randomBytes(4).toString('hex')}`;
  const total = ladder.length + 1; // each rendition plus the thumbnail
  let lastPercent = -1;
  const report = async (done: number, seconds: number): Promise<void> => {
    const fraction = (done + Math.min(1, seconds / info.durationSeconds)) / total;
    const percent = Math.min(99, Math.floor(fraction * 100));
    if (percent !== lastPercent) {
      lastPercent = percent;
      await deps.onProgress?.(percent);
    }
  };

  try {
    fs.mkdirSync(temp, { recursive: true });
    const entries: Array<{ spec: RenditionSpec; width: number; height: number }> = [];
    for (const [i, spec] of ladder.entries()) {
      const size = renditionSize(info, spec);
      const dir = path.join(temp, spec.name);
      fs.mkdirSync(dir, { recursive: true });
      let pending: Promise<void> = Promise.resolve();
      track(
        await runFfmpeg(
          deps.ffmpegPath,
          renditionArgs(inputPath, dir, spec, size, info.hasAudio, deps.threads),
          (t) => {
            pending = pending.then(() => report(i, t)).catch(() => undefined);
          },
          deps.signal,
        ),
      );
      await pending;
      if (!fs.existsSync(path.join(dir, 'index.m3u8'))) throw new MediaError('Transcoding produced no output', false);
      entries.push({ spec, ...size });
      await report(i + 1, 0);
    }

    fs.writeFileSync(path.join(temp, 'master.m3u8'), buildMasterPlaylist(entries));
    const at = Math.max(0, info.durationSeconds * 0.1);
    await runFfmpeg(
      deps.ffmpegPath,
      [...(deps.threads ? ['-threads', String(deps.threads)] : []), '-ss', at.toFixed(3), '-i', inputPath, '-frames:v', '1', '-vf', 'scale=-2:min(ih\\,360)', '-q:v', '3', path.join(temp, 'thumbnail.jpg')],
      undefined,
      deps.signal,
    );
    if (!fs.existsSync(path.join(temp, 'thumbnail.jpg'))) throw new MediaError('Could not create a thumbnail', false);

    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(outputDir), { recursive: true });
    fs.renameSync(temp, outputDir);
    await deps.onProgress?.(100);
    return {
      manifestPath: path.join(outputDir, 'master.m3u8'),
      thumbnailPath: path.join(outputDir, 'thumbnail.jpg'),
      durationSeconds: info.durationSeconds,
      renditions: ladder.map((r) => r.name),
      stats: { seconds: Math.round((Date.now() - started) / 100) / 10, peakRssMiB: peakRssKiB === null ? null : Math.round(peakRssKiB / 1024) },
    };
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw err;
  }
}
