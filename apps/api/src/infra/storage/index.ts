import fs from 'node:fs';
import path from 'node:path';
import { S3Store, isObjectKey, originalKey } from '@tesor_gp/storage';
import type { Env } from '../../config/env';

/**
 * Where uploaded and transcoded media live (spec A10, amended by docs/DECISIONS.md D-STORAGE).
 * `local` keeps files on the API's disk and the API serves them; `s3` keeps them in an S3-compatible bucket and the
 * API only hands out short-lived signed URLs. Database rows hold an absolute path (local) or an object key (s3).
 */
export interface StorageProvider {
  readonly kind: 'local' | 's3';
  /** Local folder multer writes incoming multipart uploads to (s3: a temporary landing place only). */
  readonly uploadDir: string;
  readonly hlsDir: string;
  /** The bucket client when kind is "s3". */
  readonly s3: S3Store | undefined;
  /** Resolves a path under the local HLS root; returns undefined if it would escape it. */
  resolveHlsPath(videoId: string, relative: string): string | undefined;
  /** Output location and storage tag for a transcode job. */
  transcodeTarget(videoId: string): { outputDir: string; storage: 'local' | 's3' } | undefined;
  /** Moves an upload multer wrote to `tempFile` into permanent storage; returns the path or key to keep. */
  storeOriginal(tempFile: string, ownerId: string): Promise<string>;
  /** True when the file or object exists in this provider. Rows from the other provider count as missing. */
  exists(pathOrKey: string): Promise<boolean>;
  deleteFile(pathOrKey: string): Promise<void>;
  /** Removes every rendition, segment and thumbnail of a video. */
  deleteVideoMedia(videoId: string): Promise<void>;
}

/** Relative media folders resolve against the repo root (the folder whose package.json has "workspaces"), so the API, worker and seed all agree no matter which workspace they run from. */
export function resolveFromRepoRoot(p: string): string {
  if (path.isAbsolute(p)) return p;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { workspaces?: unknown };
      if (pkg.workspaces) return path.resolve(dir, p);
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(p);
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export class LocalStorage implements StorageProvider {
  readonly kind: 'local' | 's3' = 'local';
  readonly uploadDir: string;
  readonly hlsDir: string;
  readonly s3: S3Store | undefined = undefined;

  constructor(uploadDir: string, hlsDir: string) {
    this.uploadDir = resolveFromRepoRoot(uploadDir);
    this.hlsDir = resolveFromRepoRoot(hlsDir);
    fs.mkdirSync(this.uploadDir, { recursive: true });
    fs.mkdirSync(this.hlsDir, { recursive: true });
  }

  resolveHlsPath(videoId: string, relative: string): string | undefined {
    if (!SAFE_ID.test(videoId)) return undefined;
    const base = path.join(this.hlsDir, videoId);
    const target = path.resolve(base, relative);
    return target === base || target.startsWith(base + path.sep) ? target : undefined;
  }

  transcodeTarget(videoId: string): { outputDir: string; storage: 'local' | 's3' } | undefined {
    const outputDir = this.resolveHlsPath(videoId, '.');
    return outputDir ? { outputDir, storage: 'local' } : undefined;
  }

  async storeOriginal(tempFile: string, _ownerId?: string): Promise<string> {
    return tempFile;
  }

  async exists(pathOrKey: string): Promise<boolean> {
    return !isObjectKey(pathOrKey) && fs.existsSync(pathOrKey);
  }

  async deleteFile(file: string): Promise<void> {
    if (!isObjectKey(file)) await fs.promises.rm(file, { force: true });
  }

  async deleteVideoMedia(videoId: string): Promise<void> {
    const dir = this.resolveHlsPath(videoId, '.');
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

export class ObjectStorage extends LocalStorage {
  override readonly kind = 's3' as const;
  override readonly s3: S3Store;

  constructor(store: S3Store, uploadDir: string, hlsDir: string) {
    super(uploadDir, hlsDir);
    this.s3 = store;
  }

  override transcodeTarget(videoId: string): { outputDir: string; storage: 'local' | 's3' } | undefined {
    return SAFE_ID.test(videoId) ? { outputDir: `hls/${videoId}/`, storage: 's3' } : undefined;
  }

  override async storeOriginal(tempFile: string, ownerId: string): Promise<string> {
    const key = originalKey(ownerId, path.basename(tempFile));
    try {
      await this.s3.putFile(key, tempFile);
    } finally {
      await fs.promises.rm(tempFile, { force: true });
    }
    return key;
  }

  override async exists(pathOrKey: string): Promise<boolean> {
    return isObjectKey(pathOrKey) ? this.s3.exists(pathOrKey) : false;
  }

  override async deleteFile(pathOrKey: string): Promise<void> {
    if (isObjectKey(pathOrKey)) await this.s3.deleteKey(pathOrKey);
    else await super.deleteFile(pathOrKey);
  }

  override async deleteVideoMedia(videoId: string): Promise<void> {
    if (!SAFE_ID.test(videoId)) return;
    await this.s3.deletePrefix(`hls/${videoId}/`);
    await super.deleteVideoMedia(videoId);
  }
}

type StorageEnv = Pick<
  Env,
  'STORAGE_PROVIDER' | 'UPLOAD_DIR' | 'HLS_OUTPUT_DIR' | 'S3_ENDPOINT' | 'S3_REGION' | 'S3_BUCKET' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY' | 'S3_FORCE_PATH_STYLE'
>;

export function createStorage(env: StorageEnv): StorageProvider {
  if (env.STORAGE_PROVIDER === 'local') return new LocalStorage(env.UPLOAD_DIR, env.HLS_OUTPUT_DIR);
  if (env.STORAGE_PROVIDER === 's3' && env.S3_ENDPOINT && env.S3_REGION && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
    const store = new S3Store({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
    return new ObjectStorage(store, env.UPLOAD_DIR, env.HLS_OUTPUT_DIR);
  }
  throw new Error(`Storage provider "${env.STORAGE_PROVIDER}" is not configured. Use STORAGE_PROVIDER=local, or s3 with every S3_* setting.`);
}
