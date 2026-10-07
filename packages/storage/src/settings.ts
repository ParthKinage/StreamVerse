import type { S3Settings } from './s3';

const REQUIRED = ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;

/**
 * Reads the S3 settings from the environment. Throws one error naming every missing variable (never their values),
 * so a misconfigured deploy fails at startup instead of on the first upload.
 */
export function s3SettingsFromEnv(env: NodeJS.ProcessEnv = process.env): S3Settings {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  if (missing.length) throw new Error(`STORAGE_PROVIDER=s3 needs ${missing.join(', ')}`);
  return {
    endpoint: env.S3_ENDPOINT!.trim(),
    region: env.S3_REGION!.trim(),
    bucket: env.S3_BUCKET!.trim(),
    accessKeyId: env.S3_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!.trim(),
    forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
  };
}
