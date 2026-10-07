/**
 * Object key layout in the bucket:
 *   originals/<videoId or upload id>/<random>.<ext>    the file the creator uploaded
 *   hls/<videoId>/<version>/master.m3u8                  renditions, segments and thumbnail.jpg
 * Each transcode writes a new <version> folder, so a retry never overwrites files a viewer may be playing, and the
 * thumbnail URL changes whenever the picture does (safe to cache for a long time).
 */
export function originalKey(ownerId: string, fileName: string): string {
  return `originals/${ownerId}/${fileName}`;
}

export function hlsPrefix(videoId: string, version: string): string {
  return `hls/${videoId}/${version}/`;
}

/** Local-disk paths are absolute; object keys are relative forward-slash paths. Rows from either era can coexist. */
export function isObjectKey(p: string): boolean {
  return /^(originals|hls)\//.test(p);
}
