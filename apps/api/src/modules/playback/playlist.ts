import path from 'node:path';

export type UrlSigner = (key: string, expiresInSec: number) => Promise<string>;

/**
 * Resolves a relative path (from the request URL, or a URI line in a playlist inside `fromDir`) to an object key.
 * Returns undefined for anything that would leave the folder of the master playlist or is not a plain relative path.
 */
export function resolveMediaKey(manifestKey: string, relative: string, fromDir = path.posix.dirname(manifestKey)): string | undefined {
  if (!relative || relative.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(relative) || relative.startsWith('/')) return undefined;
  const base = path.posix.dirname(manifestKey);
  const key = path.posix.normalize(path.posix.join(fromDir, relative));
  return key.startsWith(`${base}/`) ? key : undefined;
}

/**
 * Rewrites a media playlist so every segment line is a signed object-storage URL.
 *
 * Each URL expires `slackSec` after the moment its segment starts at normal playback speed, so a viewer who presses
 * play now can watch to the end without the URLs running out, but a copied playlist stops working shortly after.
 * When a viewer pauses for longer than the slack, the player asks for a fresh playlist (see the web player).
 */
export async function signMediaPlaylist(text: string, playlistKey: string, manifestKey: string, sign: UrlSigner, slackSec: number): Promise<string> {
  const dir = path.posix.dirname(playlistKey);
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let start = 0;
  let pendingDuration = 0;
  for (const line of lines) {
    const inf = /^#EXTINF:([\d.]+)/.exec(line);
    if (inf) {
      pendingDuration = Number(inf[1]) || 0;
      out.push(line);
      continue;
    }
    const map = /^(#EXT-X-MAP:.*URI=")([^"]+)(".*)$/.exec(line);
    if (map) {
      const key = resolveMediaKey(manifestKey, map[2] as string, dir);
      out.push(key ? `${map[1]}${await sign(key, slackSec)}${map[3]}` : line);
      continue;
    }
    if (line && !line.startsWith('#')) {
      const key = resolveMediaKey(manifestKey, line.trim(), dir);
      if (!key) throw new Error(`Playlist ${playlistKey} has a segment outside its folder`);
      out.push(await sign(key, Math.ceil(start + slackSec)));
      start += pendingDuration;
      pendingDuration = 0;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Playlists in a version folder never change, so they are cached in memory (bounded) instead of fetched per request.
 * Entries expire after `ttlMs` so a deleted video stops resolving soon after its files are removed.
 */
export class PlaylistCache {
  private readonly items = new Map<string, { text: string; until: number }>();
  constructor(
    private readonly max = 500,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string, load: (key: string) => Promise<string | undefined>): Promise<string | undefined> {
    const hit = this.items.get(key);
    if (hit && hit.until > this.now()) return hit.text;
    this.items.delete(key);
    const text = await load(key);
    if (text === undefined) return undefined;
    if (this.items.size >= this.max) this.items.delete(this.items.keys().next().value as string);
    this.items.set(key, { text, until: this.now() + this.ttlMs });
    return text;
  }
}
