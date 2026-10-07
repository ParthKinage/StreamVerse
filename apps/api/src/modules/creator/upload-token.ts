import crypto from 'node:crypto';

/** What a direct-upload token promises: user `u` may turn object `k` (at most `s` bytes of type `t`) into a video. */
export interface UploadClaims {
  k: string;
  u: string;
  s: number;
  t: string;
  /** expiry, unix seconds */
  exp: number;
}

// Domain-separated from playback tokens, which share the same secret.
const sign = (payload: string, secret: string): string => crypto.createHmac('sha256', secret).update(`upload:${payload}`).digest('base64url');

export function signUploadToken(claims: UploadClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyUploadToken(token: string, secret: string, nowSec: number): UploadClaims | undefined {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return undefined;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload, secret));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return undefined;
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as UploadClaims;
    if (typeof c.k !== 'string' || typeof c.u !== 'string' || typeof c.s !== 'number' || typeof c.t !== 'string' || typeof c.exp !== 'number') return undefined;
    return c.exp > nowSec ? c : undefined;
  } catch {
    return undefined;
  }
}
