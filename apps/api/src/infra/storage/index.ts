import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../../config/env';

/** Abstraction over where uploaded and transcoded media live. Only `local` is implemented (spec A10). */
export interface StorageProvider {
  readonly kind: 'local';
  readonly uploadDir: string;
  readonly hlsDir: string;
  /** Resolves a path under the HLS root; returns undefined if it would escape it. */
  resolveHlsPath(videoId: string, relative: string): string | undefined;
  deleteFile(file: string): Promise<void>;
  deleteHlsDir(videoId: string): Promise<void>;
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

export class LocalStorage implements StorageProvider {
  readonly kind = 'local' as const;
  readonly uploadDir: string;
  readonly hlsDir: string;

  constructor(uploadDir: string, hlsDir: string) {
    this.uploadDir = resolveFromRepoRoot(uploadDir);
    this.hlsDir = resolveFromRepoRoot(hlsDir);
    fs.mkdirSync(this.uploadDir, { recursive: true });
    fs.mkdirSync(this.hlsDir, { recursive: true });
  }

  resolveHlsPath(videoId: string, relative: string): string | undefined {
    if (!/^[A-Za-z0-9_-]+$/.test(videoId)) return undefined;
    const base = path.join(this.hlsDir, videoId);
    const target = path.resolve(base, relative);
    return target === base || target.startsWith(base + path.sep) ? target : undefined;
  }

  async deleteFile(file: string): Promise<void> {
    await fs.promises.rm(file, { force: true });
  }

  async deleteHlsDir(videoId: string): Promise<void> {
    const dir = this.resolveHlsPath(videoId, '.');
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

export function createStorage(env: Pick<Env, 'STORAGE_PROVIDER' | 'UPLOAD_DIR' | 'HLS_OUTPUT_DIR'>): StorageProvider {
  if (env.STORAGE_PROVIDER !== 'local') {
    throw new Error(`Storage provider "${env.STORAGE_PROVIDER}" is not implemented. Use STORAGE_PROVIDER=local.`);
  }
  return new LocalStorage(env.UPLOAD_DIR, env.HLS_OUTPUT_DIR);
}
