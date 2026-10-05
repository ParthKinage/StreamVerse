import crypto from 'node:crypto';

export interface PlaybackClaims {
  /** session id */
  sid: string;
  /** user id */
  uid: string;
  /** expiry, unix seconds */
  exp: number;
}

const b64 = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signPlaybackToken(claims: PlaybackClaims, secret: string): string {
  const payload = b64(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}

export type VerifyResult = { ok: true; claims: PlaybackClaims } | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' };

export function verifyPlaybackToken(token: string, secret: string, nowSec: number): VerifyResult {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return { ok: false, reason: 'malformed' };
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PlaybackClaims;
    if (typeof claims.sid !== 'string' || typeof claims.uid !== 'string' || typeof claims.exp !== 'number') return { ok: false, reason: 'malformed' };
    if (claims.exp <= nowSec) return { ok: false, reason: 'expired' };
    return { ok: true, claims };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/** Token that lets navigator.sendBeacon end a session without an Authorization header. */
export function signEndToken(sessionId: string, secret: string): string {
  return sign(`end:${sessionId}`, secret);
}

export function verifyEndToken(sessionId: string, token: string, secret: string): boolean {
  const a = Buffer.from(token);
  const b = Buffer.from(signEndToken(sessionId, secret));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const PLAYBACK_COOKIE = 'pbt';
