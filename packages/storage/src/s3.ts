import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Connection settings for any S3-compatible service (Backblaze B2, Cloudflare R2, MinIO, AWS S3). */
export interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO needs path-style URLs (http://host/bucket/key); hosted services work either way. */
  forcePathStyle?: boolean;
}

export interface ObjectInfo {
  size: number;
  contentType: string | undefined;
}

/** Signed URLs may not outlive this (the S3 SigV4 maximum is 7 days). */
export const MAX_SIGNED_URL_SEC = 7 * 24 * 3600;

const CONTENT_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Object keys are always forward-slash paths without a leading slash, whatever the OS. */
export function joinKey(...parts: string[]): string {
  return parts
    .flatMap((p) => p.split(/[\\/]+/))
    .filter((p) => p && p !== '.')
    .join('/');
}

function isNotFound(err: unknown): boolean {
  if (err instanceof S3ServiceException) return err.$metadata.httpStatusCode === 404 || err.name === 'NotFound' || err.name === 'NoSuchKey';
  return false;
}

/**
 * Thin wrapper over the AWS SDK. It is the only place in the repository that talks to object storage, the same way
 * `@tesor_gp/blockchain` is the only place that talks to the chain.
 */
export class S3Store {
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(settings: S3Settings, client?: S3Client) {
    this.bucket = settings.bucket;
    this.client =
      client ??
      new S3Client({
        endpoint: settings.endpoint,
        region: settings.region,
        forcePathStyle: settings.forcePathStyle ?? false,
        credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
        // B2 and MinIO reject the optional CRC32 checksums newer SDKs add by default.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
  }

  /** Creates the bucket if it does not exist (local development and tests; hosted buckets are made in the console). */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async head(key: string): Promise<ObjectInfo | undefined> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(res.ContentLength ?? 0), contentType: res.ContentType };
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== undefined;
  }

  async getText(key: string): Promise<string | undefined> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return await res.Body?.transformToString('utf8');
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async downloadToFile(key: string, file: string): Promise<void> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Object ${key} has no body`);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await pipeline(res.Body as Readable, fs.createWriteStream(file));
  }

  async putFile(key: string, file: string, opts: { contentType?: string; cacheControl?: string } = {}): Promise<void> {
    const { size } = await fs.promises.stat(file);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: fs.createReadStream(file),
        ContentLength: size,
        ContentType: opts.contentType ?? contentTypeFor(file),
        ...(opts.cacheControl ? { CacheControl: opts.cacheControl } : {}),
      }),
    );
  }

  /** Writes a small object from memory (a playlist, for example). */
  async putBytes(key: string, body: Uint8Array | string, opts: { contentType?: string; cacheControl?: string } = {}): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType ?? contentTypeFor(key),
        ...(opts.cacheControl ? { CacheControl: opts.cacheControl } : {}),
      }),
    );
  }

  /** Uploads every file under `dir` to `prefix/<relative path>`, a few at a time. Returns the keys written. */
  async putDirectory(prefix: string, dir: string, opts: { cacheControl?: (file: string) => string | undefined; concurrency?: number } = {}): Promise<string[]> {
    const files = listFiles(dir);
    const keys: string[] = [];
    const queue = [...files];
    const workers = Array.from({ length: Math.min(opts.concurrency ?? 4, queue.length) }, async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const key = joinKey(prefix, path.relative(dir, file));
        const cacheControl = opts.cacheControl?.(file);
        await this.putFile(key, file, cacheControl ? { cacheControl } : {});
        keys.push(key);
      }
    });
    await Promise.all(workers);
    return keys;
  }

  /** Deletes every object whose key starts with `prefix` (which should end in "/"). */
  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const objects = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (objects.length) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects, Quiet: true } }));
        deleted += objects.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }

  async deleteKey(key: string): Promise<void> {
    await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: [{ Key: key }], Quiet: true } }));
  }

  /** A URL anyone holding it may GET until it expires. Signing is local: no network call. */
  signedGetUrl(key: string, expiresInSec: number, responseCacheControl?: string): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(responseCacheControl ? { ResponseCacheControl: responseCacheControl } : {}) });
    return getSignedUrl(this.client, cmd, { expiresIn: clampTtl(expiresInSec) });
  }

  /**
   * A URL the browser PUTs one file to. The Content-Type is part of the signature, so the browser must send exactly
   * this value. S3 cannot cap the size of a presigned PUT, so callers check it with `head` afterwards.
   */
  signedPutUrl(key: string, contentType: string, expiresInSec: number): Promise<string> {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
    return getSignedUrl(this.client, cmd, { expiresIn: clampTtl(expiresInSec), signableHeaders: new Set(['content-type']) });
  }

  /** Lets browsers on `origins` upload (PUT) and play (GET/HEAD) objects directly. */
  async setCors(origins: string[]): Promise<void> {
    await this.client.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: origins,
              AllowedMethods: ['GET', 'HEAD', 'PUT'],
              AllowedHeaders: ['content-type', 'range'],
              ExposeHeaders: ['etag', 'content-length', 'content-range'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
  }
}

function clampTtl(sec: number): number {
  return Math.max(1, Math.min(MAX_SIGNED_URL_SEC, Math.ceil(sec)));
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
