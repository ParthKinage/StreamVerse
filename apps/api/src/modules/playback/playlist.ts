import path from 'node:path';

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
