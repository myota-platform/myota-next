import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function createUploadSpoolDirectory(prefix: string) {
  const configuredRoot = process.env.MYOTA_UPLOAD_SPOOL_DIR?.trim();
  const root = configuredRoot || tmpdir();
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, prefix));
}
