import { useSyncExternalStore } from 'react';
import { liveApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Compositor, canComposite } from './compositor';
import { setOnAir } from './onAir';
import { BrowserCannotStream, LiveSender, type SenderStatus } from './sender';

export type Source = 'camera' | 'screen' | 'both';

export interface LiveSessionState {
  /** The stream the camera or screen belongs to. */
  streamId: string | null;
  source: Source;
  /** A camera, screen or both are open and showing in the preview. */
  hasMedia: boolean;
  mediaError: string | null;
  /** Null until the creator presses Go live. */
  status: SenderStatus | null;
}

const SENDING = new Set(['connecting', 'live', 'stopping']);

export function isSending(s: LiveSessionState): boolean {
  return Boolean(s.status && SENDING.has(s.status.phase));
}

/**
 * The creator's live session: camera or screen, the mixer and the sender. It lives outside any page, so moving between
 * Studio tabs or other pages of the app keeps the stream going; only ending the stream or closing the page stops it
 * (closing asks first).
 */
class LiveSession {
  private state: LiveSessionState = { streamId: null, source: 'camera', hasMedia: false, mediaError: null, status: null };
  private readonly listeners = new Set<() => void>();
  private media: MediaStream | null = null;
  private compositor: Compositor | null = null;
  private sender: LiveSender | null = null;
  private previewEl: HTMLVideoElement | HTMLCanvasElement | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', (e) => {
        // Closing the page would stop the stream and leave viewers waiting until it times out: ask first.
        if (isSending(this.state)) e.preventDefault();
      });
    }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): LiveSessionState => this.state;

  private set(patch: Partial<LiveSessionState>): void {
    this.state = { ...this.state, ...patch };
    setOnAir(isSending(this.state));
    for (const fn of this.listeners) fn();
  }

  /** Shows the open camera or screen in a page element (the element can change as pages come and go). */
  attachPreview(el: HTMLVideoElement | HTMLCanvasElement | null): void {
    this.previewEl = el;
    if (this.compositor) this.compositor.setPreview(el instanceof HTMLCanvasElement ? el : null);
    else if (el instanceof HTMLVideoElement) el.srcObject = this.media;
  }

  /** Opens the camera, the screen, or both, for this stream. */
  async acquire(streamId: string, source: Source, devices: { cameraId?: string; micId?: string }): Promise<void> {
    if (isSending(this.state)) return;
    this.set({ mediaError: null });
    const opened: MediaStream[] = [];
    try {
      const mic: MediaTrackConstraints | boolean = devices.micId ? { deviceId: { exact: devices.micId } } : true;
      const camera = (): Promise<MediaStream> =>
        navigator.mediaDevices.getUserMedia({
          video: { ...(devices.cameraId ? { deviceId: { exact: devices.cameraId } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          audio: mic,
        });
      let media: MediaStream;
      let compositor: Compositor | null = null;
      if (source === 'camera') {
        media = await camera();
        opened.push(media);
      } else {
        if (source === 'both' && !canComposite()) throw new BrowserCannotStream('This browser cannot mix a screen and a camera. Use a recent Chrome or Edge.');
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
        opened.push(screen);
        const withCamera = source === 'both' ? await camera() : await navigator.mediaDevices.getUserMedia({ audio: mic }).catch(() => null);
        if (withCamera) opened.push(withCamera);
        // One sound goes out: the microphone if there is one, otherwise the shared tab's sound.
        const audio = withCamera?.getAudioTracks()[0] ?? screen.getAudioTracks()[0];
        const screenTrack = screen.getVideoTracks()[0];
        const cameraTrack = withCamera?.getVideoTracks()[0];
        if (source === 'both' && screenTrack && cameraTrack) {
          compositor = new Compositor(screenTrack, cameraTrack);
          compositor.start();
          media = new MediaStream([screenTrack, cameraTrack, ...(audio ? [audio] : [])]);
        } else {
          media = new MediaStream([...(screenTrack ? [screenTrack] : []), ...(audio ? [audio] : [])]);
        }
      }
      this.release();
      this.media = media;
      this.compositor = compositor;
      this.set({ streamId, source, hasMedia: true, status: null });
      this.attachPreview(this.previewEl);
    } catch (err) {
      for (const m of opened) m.getTracks().forEach((t) => t.stop());
      const name = (err as Error).name;
      this.set({
        mediaError:
          err instanceof BrowserCannotStream
            ? err.message
            : name === 'NotAllowedError'
              ? 'Allow access to your camera and microphone (or screen) to go live.'
              : `Could not open the ${source === 'camera' ? 'camera' : 'screen'}: ${(err as Error).message}`,
      });
    }
  }

  async goLive(): Promise<void> {
    const { streamId } = this.state;
    if (!this.media || !streamId || isSending(this.state)) return;
    const preview = (): HTMLVideoElement | HTMLCanvasElement | null => this.previewEl;
    this.sender = new LiveSender(streamId, this.media, liveApi, (status) => this.set({ status }), preview, this.compositor ?? undefined);
    this.set({ status: { phase: 'connecting', sent: 0, waiting: 0, dropped: 0 } });
    try {
      await this.sender.start();
    } catch (err) {
      this.set({ status: { phase: 'error', sent: 0, waiting: 0, dropped: 0, message: err instanceof BrowserCannotStream ? err.message : errorMessage(err) } });
    }
  }

  /** Sends what is left and stops sending; the camera or screen stays open. */
  async stopSending(): Promise<void> {
    await this.sender?.stop();
    this.sender = null;
  }

  /** Closes the camera and screen and forgets the stream. */
  release(): void {
    this.compositor?.stop();
    this.compositor = null;
    this.media?.getTracks().forEach((t) => t.stop());
    this.media = null;
    if (this.previewEl instanceof HTMLVideoElement) this.previewEl.srcObject = null;
    this.set({ hasMedia: false, streamId: null, status: null });
  }
}

export const liveSession = new LiveSession();

export function useLiveSession(): LiveSessionState {
  return useSyncExternalStore(liveSession.subscribe, liveSession.getState, liveSession.getState);
}
