/* Prepares the object-storage bucket named in .env (STORAGE_PROVIDER=s3) so browsers can upload to and play from it.
 * Usage:  npm run setup:bucket                      (allows the hosted site and http://localhost:3000)
 *         npm run setup:bucket -- https://other.app (allows exactly the origins given)
 * Needs `npm run build -w @tesor_gp/storage` first. It prints the bucket name, never the keys. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'packages', 'storage', 'package.json'));
const dotenv = require('dotenv');
const { S3Store, s3SettingsFromEnv } = require('@tesor_gp/storage');

dotenv.config({ path: path.join(root, '.env') });
if (process.env.STORAGE_PROVIDER !== 's3') {
  console.error('STORAGE_PROVIDER is not "s3" in .env; nothing to do.');
  process.exit(1);
}
const settings = s3SettingsFromEnv();
const origins = process.argv.slice(2).length ? process.argv.slice(2) : ['https://stream-verse-opal.vercel.app', 'http://localhost:3000'];
const store = new S3Store(settings);

try {
  if (/localhost|127\.0\.0\.1/.test(settings.endpoint)) await store.ensureBucket();
  await store.setCors(origins);
  // A round trip proves the keys can write, read and delete.
  const probe = `healthcheck/${Date.now()}.txt`;
  const tmp = path.join(root, '.bucket-check.tmp');
  fs.writeFileSync(tmp, 'ok');
  await store.putFile(probe, tmp, { contentType: 'text/plain' });
  fs.rmSync(tmp, { force: true });
  const back = await store.getText(probe);
  await store.deleteKey(probe);
  if (back !== 'ok') throw new Error('wrote a test file but could not read it back');
  console.log(`Bucket "${settings.bucket}" is ready. Browser access allowed from: ${origins.join(', ')}`);
} catch (err) {
  console.error(`Bucket setup failed: ${err?.name ?? ''} ${err?.message ?? err}`);
  process.exit(1);
}
