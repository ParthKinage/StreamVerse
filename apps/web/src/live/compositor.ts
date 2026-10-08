/**
 * Mixes a screen (or window) and a camera into one picture, like a simple OBS scene: the screen fills the frame and the
 * camera sits in a corner.
 *
 * Frames are read straight from the tracks (MediaStreamTrackProcessor) and drawn on an OffscreenCanvas. Nothing here
 * depends on page rendering or page timers, which browsers pause or slow down in background tabs, so the stream keeps
 * going while the creator works in another tab or window. Each camera frame produces one output frame (the camera
 * delivers a steady rate; a screen only sends frames when something on it changes).
 */

export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface Layout {
  width: number;
  height: number;
  /** Camera width as a share of the output width. */
  cameraShare: number;
  corner: Corner;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a source of size sw x sh goes to fit inside a box of bw x bh without being cut (letterboxed). */
export function containRect(sw: number, sh: number, bw: number, bh: number): Rect {
  if (!sw || !sh) return { x: 0, y: 0, w: bw, h: bh };
  const scale = Math.min(bw / sw, bh / sh);
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  return { x: Math.round((bw - w) / 2), y: Math.round((bh - h) / 2), w, h };
}

/** Where the camera picture goes: its own aspect ratio, a share of the output width, in the chosen corner. */
export function cameraRect(cw: number, ch: number, layout: Layout): Rect {
  const margin = Math.round(layout.width * 0.02);
  const w = Math.round(layout.width * layout.cameraShare);
  const h = Math.round(w * (ch && cw ? ch / cw : 9 / 16));
  const x = layout.corner.endsWith('right') ? layout.width - w - margin : margin;
  const y = layout.corner.startsWith('bottom') ? layout.height - h - margin : margin;
  return { x, y, w, h };
}

export function canComposite(): boolean {
  return typeof window !== 'undefined' && 'MediaStreamTrackProcessor' in window && 'OffscreenCanvas' in window && 'VideoFrame' in window;
}

type FrameSink = (canvas: OffscreenCanvas, timestampSec: number) => void;

export class Compositor {
  readonly layout: Layout;
  private readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private screenFrame: VideoFrame | null = null;
  private screenEnded = false;
  private stopped = false;
  private sink: FrameSink | null = null;
  private preview: HTMLCanvasElement | null = null;
  private startedAt = 0;
  private readers: Array<ReadableStreamDefaultReader<VideoFrame>> = [];

  constructor(
    private readonly screen: MediaStreamTrack,
    private readonly camera: MediaStreamTrack,
    layout: Partial<Layout> = {},
  ) {
    this.layout = { width: 1280, height: 720, cameraShare: 0.25, corner: 'bottom-right', ...layout };
    this.canvas = new OffscreenCanvas(this.layout.width, this.layout.height);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot mix the screen and the camera.');
    this.ctx = ctx;
    screen.addEventListener('ended', () => {
      this.screenEnded = true;
    });
  }

  /** Starts reading both sources. Frames are only handed out once a sink is attached. */
  start(): void {
    this.startedAt = performance.now();
    void this.readScreen();
    void this.readCamera();
  }

  /** Where finished frames go (the encoder); null stops handing them out without stopping the preview. */
  setSink(sink: FrameSink | null): void {
    this.sink = sink;
  }

  setPreview(canvas: HTMLCanvasElement | null): void {
    this.preview = canvas;
    if (canvas) {
      canvas.width = this.layout.width;
      canvas.height = this.layout.height;
    }
  }

  private reader(track: MediaStreamTrack): ReadableStreamDefaultReader<VideoFrame> {
    const processor = new MediaStreamTrackProcessor({ track: track as MediaStreamVideoTrack });
    const reader = processor.readable.getReader();
    this.readers.push(reader);
    return reader;
  }

  private async readScreen(): Promise<void> {
    const reader = this.reader(this.screen);
    while (!this.stopped) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done || !value) break;
      // Keep only the newest picture of the screen.
      this.screenFrame?.close();
      this.screenFrame = value;
    }
    this.screenEnded = true;
  }

  private async readCamera(): Promise<void> {
    const reader = this.reader(this.camera);
    while (!this.stopped) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done || !value) break;
      try {
        this.draw(value);
      } finally {
        value.close();
      }
    }
  }

  private draw(cameraFrame: VideoFrame): void {
    const { width, height } = this.layout;
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    const screen = this.screenEnded ? null : this.screenFrame;
    if (screen) {
      const r = containRect(screen.displayWidth, screen.displayHeight, width, height);
      ctx.drawImage(screen, r.x, r.y, r.w, r.h);
      const c = cameraRect(cameraFrame.displayWidth, cameraFrame.displayHeight, this.layout);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(c.x, c.y, c.w, c.h, Math.round(c.w * 0.04));
      ctx.clip();
      ctx.drawImage(cameraFrame, c.x, c.y, c.w, c.h);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(c.x, c.y, c.w, c.h, Math.round(c.w * 0.04));
      ctx.stroke();
    } else {
      // No screen (not chosen yet, or sharing stopped): show the camera on its own.
      const r = containRect(cameraFrame.displayWidth, cameraFrame.displayHeight, width, height);
      ctx.drawImage(cameraFrame, r.x, r.y, r.w, r.h);
    }
    // Drawing the preview is skipped while the page is hidden; the stream itself does not depend on it.
    if (this.preview && document.visibilityState === 'visible') this.preview.getContext('2d')?.drawImage(this.canvas, 0, 0, width, height);
    this.sink?.(this.canvas, (performance.now() - this.startedAt) / 1000);
  }

  /** The current picture, for the thumbnail. */
  snapshot(): OffscreenCanvas {
    return this.canvas;
  }

  stop(): void {
    this.stopped = true;
    for (const r of this.readers) void r.cancel().catch(() => undefined);
    this.screenFrame?.close();
    this.screenFrame = null;
    this.sink = null;
  }
}
