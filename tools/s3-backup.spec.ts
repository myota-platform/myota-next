import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readManifest, restoreBucketMap } from './s3-backup.mjs';

const temporaryDirectories: string[] = [];

async function writeManifest(manifest: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'myota-s3-backup-test-'));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, 'objects'));
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(directory, 'manifest.json'), contents);
  const checksum = createHash('sha256').update(contents).digest('hex');
  await writeFile(
    join(directory, 'manifest.sha256'),
    `${checksum}  manifest.json\n`,
  );
  return directory;
}

const validManifest = {
  manifestVersion: 1,
  createdAt: '2026-10-26T00:00:00.000Z',
  endpoint: 'http://s3.example.test',
  buckets: [
    {
      name: 'source-bucket',
      objects: [
        {
          key: 'nested/file.txt',
          path: 'objects/00000000.bin',
          size: 3,
          sha256: createHash('sha256').update('abc').digest('hex'),
          metadata: {},
          tags: [],
        },
      ],
    },
  ],
};

afterEach(async () => {
  delete process.env.MYOTA_RESTORE_BUCKET_MAP;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('S3 backup manifest', () => {
  it('accepts a checksummed manifest with safe object paths', async () => {
    const directory = await writeManifest(validManifest);
    await writeFile(join(directory, 'objects/00000000.bin'), 'abc');

    const result = await readManifest(directory);

    expect(result.manifest.buckets[0].objects[0].key).toBe('nested/file.txt');
  });

  it('rejects an object path that can escape the backup directory', async () => {
    const invalid = structuredClone(validManifest);
    invalid.buckets[0].objects[0].path = 'objects/../../outside';
    const directory = await writeManifest(invalid);

    await expect(readManifest(directory)).rejects.toThrow(
      'Backup manifest contains an invalid bucket or object',
    );
  });

  it('rejects a changed manifest checksum', async () => {
    const directory = await writeManifest(validManifest);
    await writeFile(join(directory, 'manifest.json'), '{}\n');

    await expect(readManifest(directory)).rejects.toThrow(
      'Manifest checksum does not match',
    );
  });
});

describe('restore bucket mapping', () => {
  it('requires one distinct empty destination bucket for each source', () => {
    process.env.MYOTA_RESTORE_BUCKET_MAP = JSON.stringify({
      'source-bucket': 'restore-bucket',
    });

    expect(restoreBucketMap(validManifest)).toEqual({
      'source-bucket': 'restore-bucket',
    });
  });

  it('rejects a missing destination mapping', () => {
    process.env.MYOTA_RESTORE_BUCKET_MAP = '{}';

    expect(() => restoreBucketMap(validManifest)).toThrow(
      'Map every source bucket to a unique restore bucket',
    );
  });

  it('rejects two source buckets mapping to the same destination', () => {
    process.env.MYOTA_RESTORE_BUCKET_MAP = JSON.stringify({
      'source-bucket': 'restore-bucket',
      'another-bucket': 'restore-bucket',
    });
    const manifest = {
      ...validManifest,
      buckets: [
        ...validManifest.buckets,
        { name: 'another-bucket', objects: [] },
      ],
    };

    expect(() => restoreBucketMap(manifest)).toThrow(
      'Map every source bucket to a unique restore bucket',
    );
  });
});
