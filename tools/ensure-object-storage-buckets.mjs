import {
  CreateBucketCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const endpoint = process.env.AWS_ENDPOINT_URL;
if (!endpoint) throw new Error('AWS_ENDPOINT_URL is required');

const buckets = JSON.parse(process.env.OBJECT_STORAGE_BUCKETS ?? '[]');
if (
  !Array.isArray(buckets) ||
  buckets.some((bucket) => typeof bucket !== 'string' || bucket.length === 0)
) {
  throw new Error(
    'OBJECT_STORAGE_BUCKETS must be a JSON array of bucket names',
  );
}

const client = new S3Client({
  endpoint,
  forcePathStyle: true,
  region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
});

let ready = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    await client.send(new ListBucketsCommand({}));
    ready = true;
    break;
  } catch (error) {
    if (attempt === 59) throw error;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

if (!ready) throw new Error('Object storage did not become ready');

for (const Bucket of buckets) {
  try {
    await client.send(new HeadBucketCommand({ Bucket }));
    console.log(`Bucket ${Bucket} already exists`);
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    const missing =
      status === 404 ||
      error?.name === 'NotFound' ||
      error?.name === 'NoSuchBucket';
    if (!missing) throw error;

    try {
      await client.send(new CreateBucketCommand({ Bucket }));
      console.log(`Created bucket ${Bucket}`);
    } catch (createError) {
      if (createError?.name !== 'BucketAlreadyOwnedByYou') throw createError;
      console.log(`Bucket ${Bucket} was created concurrently`);
    }
  }
}

await client.destroy();
