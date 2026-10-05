import { spawn } from 'node:child_process';

export interface ProbeResult {
  hasVideo: boolean;
  hasAudio: boolean;
  durationSeconds: number;
}

/** Runs ffprobe with an argument array (no shell) and reports the streams in the file. */
export function probeMedia(ffprobePath: string, file: string, timeoutMs = 20_000): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ffprobe timed out'));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('Not a readable media file'));
      try {
        const json = JSON.parse(out) as { streams?: Array<{ codec_type?: string; duration?: string }>; format?: { duration?: string } };
        const streams = json.streams ?? [];
        const duration = Number(json.format?.duration ?? streams.find((s) => s.codec_type === 'video')?.duration ?? 0);
        resolve({
          hasVideo: streams.some((s) => s.codec_type === 'video'),
          hasAudio: streams.some((s) => s.codec_type === 'audio'),
          durationSeconds: Number.isFinite(duration) ? duration : 0,
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}
