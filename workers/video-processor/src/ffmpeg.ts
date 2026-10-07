import { spawn } from 'node:child_process';

export class MediaError extends Error {
  constructor(
    message: string,
    /** True when retrying cannot help (corrupt or unsupported input). */
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

export interface ProbeInfo {
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { signal?: AbortSignal | undefined; onStdoutLine?: ((line: string) => void) | undefined; timeoutMs?: number | undefined } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // Argument array, never a shell: file names with spaces or metacharacters are safe, and it works on Windows.
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let buf = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => {
      child.kill('SIGKILL');
      finish(() => reject(new MediaError('Transcoding was cancelled', false)));
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          finish(() => reject(new MediaError('Media tool timed out', false)));
        }, opts.timeoutMs)
      : undefined;
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString();
      if (opts.onStdoutLine) {
        buf += text;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          opts.onStdoutLine(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
        }
      } else stdout += text;
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on('error', (err) => finish(() => reject(new MediaError(`Could not start ${cmd}: ${err.message}`, false))));
    child.on('close', (code) => finish(() => resolve({ code, stdout, stderr })));
  });
}

export async function probe(ffprobePath: string, file: string, signal?: AbortSignal): Promise<ProbeInfo> {
  const res = await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { signal, timeoutMs: 30_000 });
  if (res.code !== 0) throw new MediaError('The uploaded file is corrupt or is not a supported video', true);
  let json: { streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>; format?: { duration?: string } };
  try {
    json = JSON.parse(res.stdout);
  } catch {
    throw new MediaError('The uploaded file could not be analysed', true);
  }
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && (s.width ?? 0) > 0 && (s.height ?? 0) > 0);
  if (!video) throw new MediaError('The uploaded file has no video stream', true);
  const duration = Number(json.format?.duration ?? video.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new MediaError('The video has no readable duration', true);
  return {
    durationSeconds: duration,
    width: video.width as number,
    height: video.height as number,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

/**
 * Runs FFmpeg, reporting the encoded position in seconds (from `-progress pipe:1`) as it advances. Resolves to the
 * peak resident memory in KiB that `-benchmark` reports (it prints only at the `info` log level), or undefined.
 */
export async function runFfmpeg(ffmpegPath: string, args: string[], onTime?: (seconds: number) => void, signal?: AbortSignal): Promise<number | undefined> {
  const res = await run(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'info', '-benchmark', '-nostdin', '-nostats', '-progress', 'pipe:1', ...args], {
    signal,
    onStdoutLine: (line) => {
      const m = /^out_time_us=(\d+)$/.exec(line) ?? /^out_time_ms=(\d+)$/.exec(line);
      if (m && onTime) onTime(Number(m[1]) / 1_000_000);
    },
  });
  if (res.code !== 0) {
    const detail = res.stderr.trim().split('\n').slice(-3).join(' | ');
    const corrupt = /Invalid data|moov atom|could not find codec|Error while decoding|Invalid argument/i.test(res.stderr);
    throw new MediaError(corrupt ? 'The video could not be decoded; the file may be corrupt' : `Transcoding failed: ${detail || `ffmpeg exited with code ${res.code}`}`, corrupt);
  }
  return parseMaxRssKiB(res.stderr);
}

/** Reads `bench: maxrss=...` from FFmpeg's -benchmark output. Builds differ: "133620KiB" (Windows), "50036kB" (Ubuntu). */
export function parseMaxRssKiB(stderr: string): number | undefined {
  const rss = /maxrss=(\d+)\s*ki?b/i.exec(stderr);
  return rss ? Number(rss[1]) : undefined;
}
