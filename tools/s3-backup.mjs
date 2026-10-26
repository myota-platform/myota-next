import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const manifestVersion = 1;
const objectPath = (index) => `objects/${String(index).padStart(8, '0')}.bin`;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function makeClient() {
  const endpoint = new URL(required('S3_ENDPOINT'));
  if (!['http:', 'https:'].includes(endpoint.protocol))
    throw new Error('S3_ENDPOINT must use HTTP or HTTPS');
  return new S3Client({
    endpoint: endpoint.toString(),
    region: process.env.AWS_REGION || 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: required('AWS_ACCESS_KEY_ID'),
      secretAccessKey: required('AWS_SECRET_ACCESS_KEY'),
      ...(process.env.AWS_SESSION_TOKEN
        ? { sessionToken: process.env.AWS_SESSION_TOKEN }
        : {}),
    },
  });
}

function configuredBuckets() {
  const buckets = required('MYOTA_BACKUP_BUCKETS')
    .split(',')
    .map((bucket) => bucket.trim())
    .filter(Boolean);
  if (buckets.length === 0 || new Set(buckets).size !== buckets.length)
    throw new Error('MYOTA_BACKUP_BUCKETS must contain unique bucket names');
  return buckets;
}

function encodedTags(tags) {
  if (!tags?.length) return undefined;
  return tags
    .map(
      ({ Key, Value }) =>
        `${encodeURIComponent(Key)}=${encodeURIComponent(Value)}`,
    )
    .join('&');
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadObject(client, bucket, key, path) {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) throw new Error('S3 returned an empty object body');
  const hash = createHash('sha256');
  let bytes = 0;
  const measure = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    response.Body,
    measure,
    createWriteStream(path, { flags: 'wx', mode: 0o600 }),
  );
  return { bytes, sha256: hash.digest('hex') };
}

async function backup(destination) {
  const client = makeClient();
  const buckets = configuredBuckets();
  const target = resolve(destination);
  const root = dirname(target);
  const staging = join(root, `.${basename(target)}.${process.pid}.partial`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  await mkdir(join(staging, 'objects'), { mode: 0o700 });

  const manifest = {
    manifestVersion,
    createdAt: new Date().toISOString(),
    endpoint: new URL(required('S3_ENDPOINT')).origin,
    buckets: [],
  };
  let objectIndex = 0;
  try {
    for (const bucket of buckets) {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      try {
        const versioning = await client.send(
          new GetBucketVersioningCommand({ Bucket: bucket }),
        );
        if (versioning.Status)
          throw new Error(`Versioned bucket is not supported: ${bucket}`);
      } catch (error) {
        if (error?.name !== 'NotImplemented') throw error;
      }
      const bucketEntry = { name: bucket, objects: [] };
      let continuationToken;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken,
          }),
        );
        for (const listed of page.Contents ?? []) {
          if (listed.Key === undefined)
            throw new Error('S3 returned an object without a key');
          const key = listed.Key;
          const head = await client.send(
            new HeadObjectCommand({ Bucket: bucket, Key: key }),
          );
          let tags = [];
          try {
            tags =
              (
                await client.send(
                  new GetObjectTaggingCommand({ Bucket: bucket, Key: key }),
                )
              ).TagSet ?? [];
          } catch (error) {
            if (
              error?.name !== 'NotImplemented' &&
              error?.name !== 'NoSuchTagSet'
            )
              throw error;
          }
          const path = objectPath(objectIndex++);
          const measured = await downloadObject(
            client,
            bucket,
            key,
            join(staging, path),
          );
          if (
            head.ContentLength !== undefined &&
            measured.bytes !== head.ContentLength
          )
            throw new Error(`Object length changed during backup (${path})`);
          bucketEntry.objects.push({
            key,
            path,
            size: measured.bytes,
            sha256: measured.sha256,
            etag: head.ETag,
            contentType: head.ContentType,
            contentDisposition: head.ContentDisposition,
            contentEncoding: head.ContentEncoding,
            contentLanguage: head.ContentLanguage,
            cacheControl: head.CacheControl,
            expires: head.Expires?.toISOString(),
            metadata: head.Metadata ?? {},
            tags,
          });
        }
        continuationToken = page.IsTruncated
          ? page.NextContinuationToken
          : undefined;
      } while (continuationToken);
      manifest.buckets.push(bucketEntry);
    }

    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestPath = join(staging, 'manifest.json');
    const manifestHandle = await open(manifestPath, 'wx', 0o600);
    try {
      await manifestHandle.writeFile(manifestText);
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
    const digest = createHash('sha256').update(manifestText).digest('hex');
    await writeFile(
      join(staging, 'manifest.sha256'),
      `${digest}  manifest.json\n`,
      { mode: 0o600 },
    );
    await lstat(target).then(
      () => {
        throw new Error('Backup destination already exists');
      },
      (error) => {
        if (error?.code !== 'ENOENT') throw error;
      },
    );
    await rename(staging, target);
    process.stdout.write(
      `Backup complete: ${manifest.buckets.length} buckets, ${objectIndex} objects at ${target}\n`,
    );
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    client.destroy();
  }
}

export async function readManifest(directory) {
  const root = resolve(directory);
  const manifestPath = join(root, 'manifest.json');
  const manifestInfo = await lstat(manifestPath);
  const checksumInfo = await lstat(join(root, 'manifest.sha256'));
  if (
    !manifestInfo.isFile() ||
    manifestInfo.isSymbolicLink() ||
    !checksumInfo.isFile() ||
    checksumInfo.isSymbolicLink()
  )
    throw new Error('Backup manifest files must be regular files');
  const manifestText = await readFile(manifestPath, 'utf8');
  const checksumLine = (await readFile(join(root, 'manifest.sha256'), 'utf8'))
    .trim()
    .split(/\s+/);
  const actualChecksum = createHash('sha256')
    .update(manifestText)
    .digest('hex');
  if (checksumLine[0] !== actualChecksum || checksumLine[1] !== 'manifest.json')
    throw new Error('Manifest checksum does not match');
  const manifest = JSON.parse(manifestText);
  if (
    manifest?.manifestVersion !== manifestVersion ||
    !Array.isArray(manifest.buckets) ||
    manifest.buckets.length === 0 ||
    typeof manifest.createdAt !== 'string' ||
    typeof manifest.endpoint !== 'string'
  )
    throw new Error('Backup manifest is invalid or unsupported');
  const bucketNames = new Set();
  const objectPaths = new Set();
  for (const bucket of manifest.buckets) {
    if (
      typeof bucket.name !== 'string' ||
      bucketNames.has(bucket.name) ||
      !Array.isArray(bucket.objects) ||
      bucket.objects.some((object) => {
        if (
          typeof object.key !== 'string' ||
          !/^objects\/[0-9]{8}\.bin$/.test(object.path) ||
          objectPaths.has(object.path) ||
          !Number.isSafeInteger(object.size) ||
          object.size < 0 ||
          !/^[a-f0-9]{64}$/.test(object.sha256) ||
          !object.metadata ||
          typeof object.metadata !== 'object' ||
          !Array.isArray(object.tags)
        )
          return true;
        objectPaths.add(object.path);
        return false;
      })
    )
      throw new Error('Backup manifest contains an invalid bucket or object');
    bucketNames.add(bucket.name);
  }
  return { root, manifest };
}

export function restoreBucketMap(manifest) {
  const raw = required('MYOTA_RESTORE_BUCKET_MAP');
  const mapping = JSON.parse(raw);
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping))
    throw new Error('MYOTA_RESTORE_BUCKET_MAP must be a JSON object');
  const sourceNames = manifest.buckets.map((bucket) => bucket.name);
  const targetNames = sourceNames.map((source) => mapping[source]);
  if (
    targetNames.some((target) => typeof target !== 'string' || !target) ||
    new Set(targetNames).size !== targetNames.length
  )
    throw new Error('Map every source bucket to a unique restore bucket');
  return mapping;
}

async function ensureEmptyTarget(client, bucket) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    throw new Error(`Restore target bucket must already exist: ${bucket}`);
  }
  const page = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }),
  );
  if ((page.KeyCount ?? page.Contents?.length ?? 0) > 0)
    throw new Error(`Restore target bucket is not empty: ${bucket}`);
}

async function restore(directory) {
  const { root, manifest } = await readManifest(directory);
  const confirmation = `RESTORE ${basename(root)}`;
  if (process.env.MYOTA_RESTORE_CONFIRM !== confirmation)
    throw new Error(`Set MYOTA_RESTORE_CONFIRM to exactly: ${confirmation}`);
  const mapping = restoreBucketMap(manifest);
  const client = makeClient();
  try {
    for (const bucket of manifest.buckets)
      await ensureEmptyTarget(client, mapping[bucket.name]);
    for (const bucket of manifest.buckets) {
      const targetBucket = mapping[bucket.name];
      for (const object of bucket.objects) {
        const path = join(root, object.path);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error(
            `Backup object is not a regular file: ${object.path}`,
          );
        if (
          info.size !== object.size ||
          (await hashFile(path)) !== object.sha256
        )
          throw new Error(
            `Backup object checksum does not match: ${object.path}`,
          );
        await client.send(
          new PutObjectCommand({
            Bucket: targetBucket,
            Key: object.key,
            Body: createReadStream(path),
            ContentLength: object.size,
            ContentType: object.contentType,
            ContentDisposition: object.contentDisposition,
            ContentEncoding: object.contentEncoding,
            ContentLanguage: object.contentLanguage,
            CacheControl: object.cacheControl,
            Expires: object.expires ? new Date(object.expires) : undefined,
            Metadata: object.metadata,
            Tagging: encodedTags(object.tags),
          }),
        );
      }
    }
    process.stdout.write(
      `Restore complete: ${manifest.buckets.length} buckets, ${manifest.buckets.reduce((sum, bucket) => sum + bucket.objects.length, 0)} objects\n`,
    );
  } finally {
    client.destroy();
  }
}

async function main() {
  const [operation, directory] = process.argv.slice(2);
  if (!operation || !directory)
    throw new Error(
      'Usage: node tools/s3-backup.mjs backup DIRECTORY | restore DIRECTORY',
    );
  if (operation === 'backup') await backup(directory);
  else if (operation === 'restore') await restore(directory);
  else throw new Error('Operation must be backup or restore');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.umask(0o077);
  main().catch((error) => {
    console.error(
      'S3 backup/restore failed:',
      error?.message ?? 'unknown error',
    );
    process.exitCode = 1;
  });
}
