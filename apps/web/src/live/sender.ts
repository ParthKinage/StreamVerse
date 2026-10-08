import {
  MediaStreamAudioTrackSource,
  MediaStreamVideoTrackSource,
  Mp4OutputFormat,
  NullTarget,
  Output,
  QUALITY_MEDIUM,
  VideoSample,
  VideoSampleSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
import { LIVE_SEGMENT_MAX_MS, LIVE_SEGMENT_MIN_MS, LIVE_SEGMENT_TARGET_SEC, liveInitName, liveSegmentName, type LiveStreamDto, type LiveUploadUrlsResponse, type StartLiveRequest } from '@tesor_gp/shared';
import { ApiError } from '../api/client';
import type { Compositor } from './compositor';
import { fragmentDurationMs, readTracks, type TrackInfo } from './fmp4';

/** What the sender needs from the API (the real one is liveApi; tests pass a fake). */
export interface SenderApi {
  start(id: string, b: StartLiveRequest): Promise<LiveStreamDto>;
  uploadUrls(id: string, names: string[]): Promise<LiveUploadUrlsResponse>;
  putViaApi(path: string, data: Uint8Array | Blob, contentType: string): Promise<void>;
  commit(id: string, b: { index: number; initSeq: number; durationMs: number }): Promise<{ status: string; nextIndex: number }>;
  thumbnail(id: string): Promise<void>;
}

export type SenderPhase = 'connecting' | 'live' | 'stopping' | 'stopped' | 'error';
export interface SenderStatus {
  phase: SenderPhase;
  /** Pieces that reached the viewers. */
  sent: number;
  /** Pieces waiting to be uploaded. */
  waiting: number;
  /** Pieces dropped because the connection could not keep up. */
  dropped: number;
  message?: string;
}

/** Videos taller than this are scaled down: the browser encodes in real time, and viewers get one quality only. */
const MAX_HEIGHT = 720;
/** If more pieces than this are waiting, new ones are dropped so the stream stays close to live. */
const MAX_WAITING = 6;
const URL_BATCH = 15;
const CONNECT_TIMEOUT_MS = 20_000;
const UPLOAD_ATTEMPTS = 3;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const join = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/** 'video/mp4; codecs="avc1.42001f, mp4a.40.2"' -> 'avc1.42001f,mp4a.40.2' (the HLS CODECS value). */
export function codecsFromMime(mime: string): string {
  const m = /codecs="([^"]+)"/i.exec(mime);
  return (m?.[1] ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .join(',');
}

/** A rough bitrate for the playlist's BANDWIDTH; with one quality it only informs the player's first guess. */
export function estimateBandwidth(height: number, hasAudio: boolean): number {
  const video = height <= 360 ? 800_000 : height <= 480 ? 1_200_000 : height <= 720 ? 2_500_000 : 4_500_000;
  return video + (hasAudio ? 128_000 : 0);
}

export class BrowserCannotStream extends Error {}

/** True when this browser has the encoders a live stream needs. */
export function canStreamFromBrowser(): boolean {
  return typeof window !== 'undefined' && 'VideoEncoder' in window;
}

/**
 * Encodes a camera or screen (MediaStream) into fragmented MP4 in the browser and sends it to the API piece by piece:
 * one init piece per connection, then a piece of about 4 s at each key frame. Pieces are uploaded in order, one at a
 * time; each is added to the viewers' playlist once it has arrived.
 */
export class LiveSender {
  private output: Output | undefined;
  private ftyp = new Uint8Array();
  private moof: Uint8Array | undefined;
  private tracks: TrackInfo[] = [];
  private initSeq = 0;
  private nextIndex = 0;
  private chain: Promise<void> = Promise.resolve();
  private urls = new Map<string, { url: string; headers: Record<string, string>; viaApi: boolean; until: number }>();
  private lastFragmentAt = 0;
  private thumbnailSent = false;
  private status: SenderStatus = { phase: 'connecting', sent: 0, waiting: 0, dropped: 0 };

  constructor(
    private readonly streamId: string,
    private readonly media: MediaStream,
    private readonly api: SenderApi,
    private readonly onStatus: (s: SenderStatus) => void,
    /** Where a still for the thumbnail is taken from (the preview). */
    private readonly preview?: () => HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | null,
    /** Screen and camera mixed into one picture; when given, the video comes from it instead of the media's video track. */
    private readonly compositor?: Compositor,
  ) {}

  private update(patch: Partial<SenderStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  private fail(message: string): void {
    if (this.status.phase === 'stopped' || this.status.phase === 'error') return;
    this.update({ phase: 'error', message });
    void this.output?.cancel().catch(() => undefined);
  }

  async start(): Promise<void> {
    const video = this.media.getVideoTracks()[0];
    if (!video && !this.compositor) throw new BrowserCannotStream('Choose a camera or a screen to share.');
    const audio = this.media.getAudioTracks()[0];
    const settings = video?.getSettings() ?? {};
    const height = this.compositor ? this.compositor.layout.height : Math.min(settings.height ?? MAX_HEIGHT, MAX_HEIGHT);
    const width = this.compositor
      ? this.compositor.layout.width
      : settings.width && settings.height
        ? Math.round((settings.width * height) / settings.height / 2) * 2
        : 1280;

    const videoCodec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width, height, quality: QUALITY_MEDIUM });
    if (!videoCodec) throw new BrowserCannotStream('This browser cannot encode video. Use a recent Chrome, Edge or Safari.');
    const audioCodec = audio ? await getFirstEncodableAudioCodec(['aac', 'opus'], { quality: QUALITY_MEDIUM }) : null;

    const output = new Output({
      format: new Mp4OutputFormat({
        fastStart: 'fragmented',
        minimumFragmentDuration: LIVE_SEGMENT_TARGET_SEC,
        onFtyp: (data) => {
          this.ftyp = data.slice();
        },
        onMoov: (data) => this.onInit(join(this.ftyp, data), width, height, Boolean(audio && audioCodec)),
        onMoof: (data) => {
          this.moof = data.slice();
        },
        onMdat: (data) => {
          if (this.moof) this.onFragment(join(this.moof, data));
          this.moof = undefined;
        },
      }),
      target: new NullTarget(),
    });
    this.output = output;

    // A key frame every 2 s lets a piece close at about 4 s.
    let mixed: VideoSampleSource | undefined;
    if (this.compositor) {
      mixed = new VideoSampleSource({ codec: videoCodec, quality: QUALITY_MEDIUM, keyFrameInterval: 2 });
      output.addVideoTrack(mixed, { frameRate: 30 });
    } else {
      const videoSource = new MediaStreamVideoTrackSource(video as MediaStreamVideoTrack, {
        codec: videoCodec,
        quality: QUALITY_MEDIUM,
        keyFrameInterval: 2,
        sizeChangeBehavior: 'contain',
        ...((settings.height ?? 0) > MAX_HEIGHT ? { transform: { height: MAX_HEIGHT } } : {}),
      });
      output.addVideoTrack(videoSource);
      videoSource.errorPromise.catch((err: unknown) => this.fail(`The video encoder stopped: ${(err as Error).message}`));
    }
    if (audio && audioCodec) {
      const audioSource = new MediaStreamAudioTrackSource(audio as MediaStreamAudioTrack, { codec: audioCodec, quality: QUALITY_MEDIUM });
      output.addAudioTrack(audioSource);
      audioSource.errorPromise.catch((err: unknown) => this.fail(`The audio encoder stopped: ${(err as Error).message}`));
    }
    this.lastFragmentAt = performance.now();
    await output.start();
    if (this.compositor && mixed) this.feedFrom(this.compositor, mixed);
    // The first piece needs a picture and, when there is one, sound. If either never arrives (a microphone muted by the
    // system, a source that stopped), say so instead of showing "Connecting" for ever.
    setTimeout(() => {
      if (this.status.phase === 'connecting' && this.status.sent === 0) {
        this.fail('Nothing has arrived from the camera, screen or microphone yet. Check they are not blocked or muted, then press Go live again.');
      }
    }, CONNECT_TIMEOUT_MS);
  }

  /** Hands the mixed picture to the encoder, dropping frames while it is busy rather than queueing them. */
  private feedFrom(compositor: Compositor, source: VideoSampleSource): void {
    let busy = false;
    let first: number | undefined;
    compositor.setSink((canvas, timestampSec) => {
      if (busy || this.status.phase === 'error' || this.status.phase === 'stopped') return;
      // The mixer may have run for a while for the preview; the stream starts at zero, like its sound.
      first ??= timestampSec;
      busy = true;
      const sample = new VideoSample(canvas, { timestamp: timestampSec - first, duration: 1 / 30 });
      source
        .add(sample)
        .catch((err: unknown) => this.fail(`The video encoder stopped: ${(err as Error).message}`))
        .finally(() => {
          sample.close();
          busy = false;
        });
    });
  }

  /** Runs upload work strictly one after another, so pieces reach the playlist in order. */
  private enqueue(task: () => Promise<void>): void {
    this.update({ waiting: this.status.waiting + 1 });
    this.chain = this.chain
      .then(async () => {
        if (this.status.phase === 'error') return;
        await task();
      })
      .catch((err: unknown) => this.fail(describe(err)))
      .finally(() => this.update({ waiting: Math.max(0, this.status.waiting - 1) }));
  }

  private onInit(bytes: Uint8Array, width: number, height: number, hasAudio: boolean): void {
    this.tracks = readTracks(bytes);
    this.enqueue(async () => {
      const mime = await (this.output as Output).getMimeType();
      const stream = await this.api.start(this.streamId, { codecs: codecsFromMime(mime), width, height, bandwidth: estimateBandwidth(height, hasAudio) });
      this.initSeq = stream.initSeq;
      this.nextIndex = stream.nextIndex;
      await this.upload(liveInitName(this.initSeq), bytes);
    });
  }

  private onFragment(bytes: Uint8Array): void {
    const now = performance.now();
    const measured = fragmentDurationMs(bytes, this.tracks) ?? Math.round(now - this.lastFragmentAt);
    this.lastFragmentAt = now;
    if (measured < LIVE_SEGMENT_MIN_MS) return; // a sliver at the very end: not worth a piece
    if (this.status.waiting >= MAX_WAITING && this.status.phase !== 'stopping') {
      // The upload cannot keep up; skip this piece rather than fall further behind live.
      this.update({ dropped: this.status.dropped + 1, message: 'Your connection is too slow for this quality; some seconds were skipped.' });
      return;
    }
    const durationMs = Math.min(measured, LIVE_SEGMENT_MAX_MS);
    this.enqueue(async () => {
      const index = this.nextIndex++;
      await this.upload(liveSegmentName(index), bytes);
      await this.api.commit(this.streamId, { index, initSeq: this.initSeq, durationMs });
      this.update({ sent: this.status.sent + 1, ...(this.status.phase === 'connecting' ? { phase: 'live' as const } : {}) });
      if (!this.thumbnailSent) {
        this.thumbnailSent = true;
        void this.sendThumbnail();
      }
    });
  }

  private async urlFor(name: string): Promise<{ url: string; headers: Record<string, string>; viaApi: boolean }> {
    const hit = this.urls.get(name);
    if (hit && hit.until > Date.now()) return hit;
    // Ask for this file and the next pieces in one go: one request per minute of video instead of one per piece.
    const names = name.startsWith('seg_') ? Array.from({ length: URL_BATCH }, (_, i) => liveSegmentName(this.nextIndex - 1 + i)) : [name];
    const res = await this.api.uploadUrls(this.streamId, names);
    const until = new Date(res.expiresAt).getTime() - 30_000;
    for (const item of res.items) this.urls.set(item.name, { url: item.url, headers: item.headers, viaApi: item.viaApi, until });
    const got = this.urls.get(name);
    if (!got) throw new Error('No upload address for ' + name);
    return got;
  }

  private async upload(name: string, data: Uint8Array | Blob): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const target = await this.urlFor(name);
        const contentType = target.headers['Content-Type'] ?? 'application/octet-stream';
        if (target.viaApi) {
          await this.api.putViaApi(target.url, data, contentType);
        } else {
          const res = await fetch(target.url, { method: 'PUT', headers: target.headers, body: data as BodyInit });
          if (!res.ok) throw new Error(`Storage refused the upload (${res.status})`);
        }
        this.urls.delete(name);
        return;
      } catch (err) {
        if (err instanceof ApiError && err.status !== 0 && err.status < 500) throw err;
        if (attempt >= UPLOAD_ATTEMPTS) throw err;
        this.urls.delete(name);
        await sleep(1000 * attempt);
      }
    }
  }

  private async sendThumbnail(): Promise<void> {
    const el = this.compositor?.snapshot() ?? this.preview?.();
    if (!el) return;
    const w = el instanceof HTMLVideoElement ? el.videoWidth : el.width;
    const h = el instanceof HTMLVideoElement ? el.videoHeight : el.height;
    if (!w || !h) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = Math.round((640 * h) / w);
      canvas.getContext('2d')?.drawImage(el, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.8));
      if (!blob) return;
      await this.upload('thumbnail.jpg', blob);
      await this.api.thumbnail(this.streamId);
    } catch {
      // A missing thumbnail never stops the stream.
    }
  }

  /** Sends what is left (the last piece) and stops. The caller ends the stream afterwards. */
  async stop(): Promise<void> {
    if (this.status.phase === 'stopped') return;
    const failed = this.status.phase === 'error';
    if (!failed) this.update({ phase: 'stopping' });
    try {
      this.compositor?.setSink(null);
      if (!failed) await this.output?.finalize();
    } catch {
      // the encoder may already be gone (camera unplugged); what was sent stays sent
    }
    await this.chain;
    if (!failed) this.update({ phase: 'stopped', waiting: 0 });
  }
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'LIVE_NOT_ACTIVE') return 'This stream has ended.';
    if (err.code === 'LIVE_SEGMENT_INVALID') return 'This stream was restarted somewhere else (another tab?).';
    return err.message;
  }
  return (err as Error)?.message ?? 'Sending failed';
}
