/** What went wrong with playback, in words a viewer understands, and what the player should do about it. */
export type PlaybackProblemKind = 'not-found' | 'not-authorised' | 'processing' | 'network' | 'media' | 'unsupported';

export interface PlaybackProblem {
  kind: PlaybackProblemKind;
  message: string;
  /** "new-session" re-authorises (the playback cookie or signed URLs expired); "reload" re-attaches the stream. */
  retry: 'new-session' | 'reload' | 'none';
}

export interface HlsFailure {
  /** hls.js error type: networkError, mediaError, muxError, keySystemError, otherError. */
  type: string;
  /** HTTP status of the failed request, 0 when the request never got an answer. */
  status?: number | undefined;
  /** True when a playlist failed, false for a segment. */
  playlist: boolean;
}

/** Recovery limits before the player gives up and shows the problem with a Retry button. */
export const MAX_NETWORK_RETRIES = 4;
export const MAX_URL_REFRESHES = 2;

/** A missing file or a refused signature will not fix itself, so only these statuses are worth retrying. */
export function isTransientStatus(status: number | undefined): boolean {
  return status === undefined || status === 0 || status === 429 || status >= 500;
}

export function networkRetryDelayMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt);
}

/** Problem shown before any request, from what the catalog already says about the video. */
export function problemFromVideo(video: { processingStatus: string; transcodeProgress: number; failureReason: string | null }): PlaybackProblem | null {
  if (video.processingStatus === 'PENDING' || video.processingStatus === 'PROCESSING') {
    return { kind: 'processing', message: `This video is still being prepared (${video.transcodeProgress}%). Try again in a minute.`, retry: 'reload' };
  }
  if (video.processingStatus === 'FAILED') {
    return { kind: 'not-found', message: video.failureReason ?? 'This video could not be prepared for playback.', retry: 'none' };
  }
  return null;
}

/** Turns a fatal hls.js error that recovery could not fix into a message and a retry action. */
export function describeFailure(f: HlsFailure): PlaybackProblem {
  if (f.type === 'networkError') {
    if (f.status === 401 || f.status === 403) {
      return { kind: 'not-authorised', message: 'Your viewing session has expired or is not allowed for this video.', retry: 'new-session' };
    }
    if (f.status === 404) {
      return f.playlist
        ? { kind: 'not-found', message: "This video's files could not be found. The creator may need to upload it again.", retry: 'none' }
        : { kind: 'not-found', message: 'Part of this video is missing from storage.', retry: 'reload' };
    }
    if (f.status === 429) return { kind: 'network', message: 'Playback is ahead of your confirmed watch time. It will continue in a moment.', retry: 'reload' };
    return { kind: 'network', message: 'The connection to the video was lost. Check your internet connection.', retry: 'reload' };
  }
  if (f.type === 'mediaError') return { kind: 'media', message: 'Your browser could not decode this video.', retry: 'reload' };
  return { kind: 'unsupported', message: 'This video could not be played.', retry: 'reload' };
}

/** Cookies go only to our own origin (the playback cookie); signed storage URLs must be fetched without them. */
export function sendCredentials(url: string, origin: string): boolean {
  try {
    return new URL(url, origin).origin === origin;
  } catch {
    return false;
  }
}
