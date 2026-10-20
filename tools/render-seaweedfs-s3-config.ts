import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const bucket = process.env.MYOTA_PROFILE_IMAGE_BUCKET ?? '';
const adminAccess = process.env.MYOTA_OBJECT_STORAGE_ACCESS_KEY ?? '';
const adminSecret = process.env.MYOTA_OBJECT_STORAGE_SECRET_KEY ?? '';
const profileAccess = process.env.MYOTA_PROFILE_IMAGE_ACCESS_KEY ?? '';
const profileSecret = process.env.MYOTA_PROFILE_IMAGE_SECRET_KEY ?? '';
const output = resolve(process.env.OUTPUT_PATH ?? '/config/s3.json');

if (
  ![bucket, adminAccess, adminSecret, profileAccess, profileSecret].every(
    Boolean,
  )
)
  throw new Error('S3 bucket and both credential pairs must be configured');
if (adminAccess === profileAccess || adminSecret === profileSecret)
  throw new Error(
    'Profile image credentials must be separate from storage admin credentials',
  );

const config = {
  identities: [
    {
      name: 'myota-storage-admin',
      credentials: [{ accessKey: adminAccess, secretKey: adminSecret }],
      actions: ['Admin', 'Read', 'List', 'Tagging', 'Write'],
    },
    {
      name: 'myota-identity-profile-images',
      credentials: [{ accessKey: profileAccess, secretKey: profileSecret }],
      actions: [`Read:${bucket}`, `Write:${bucket}`, `List:${bucket}`],
    },
  ],
};

await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const file = await open(output, 'w', 0o600);
try {
  await file.writeFile(`${JSON.stringify(config)}\n`, 'utf8');
  await file.chmod(0o600);
} finally {
  await file.close();
}
