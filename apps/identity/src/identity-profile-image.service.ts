import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import {
  pythonKeyErrorDetail,
  trimPythonWhitespace,
} from '@app/platform/python-strings.js';
import { writeSecurityEvent } from '@app/platform/outbox.js';
import type { IdentityAuthService } from './auth.service.js';

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_DIMENSION = 4096;
const OUTPUT_DIMENSION = 512;
const MAX_OUTPUT_BYTES = 256 * 1024;
const INPUT_FORMATS: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

interface ProfileImageRecord {
  profile_image_id: string | null;
  profile_image_media_type: string | null;
  profile_image_updated_at: Date | null;
}

@Injectable()
export class IdentityProfileImageService {
  private s3Client: S3Client | undefined;

  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
    private readonly auth: IdentityAuthService,
  ) {}

  async getOwnProfileImage(authorization: string): Promise<Buffer> {
    const actor = await this.auth.currentAccount(authorization);
    return this.getAccountProfileImage(authorization, accountIdOf(actor));
  }

  async getAccountProfileImage(
    authorization: string,
    accountId: string,
  ): Promise<Buffer> {
    await this.authorizeTarget(authorization, accountId);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(accountId))
      throw new NotFoundException(pythonKeyErrorDetail(accountId));
    const client = await this.connect();
    let imageId: string | null;
    try {
      const result = await client.query<ProfileImageRecord>(
        `SELECT p.profile_image_id, p.profile_image_media_type,
                p.profile_image_updated_at
           FROM public.account a
           LEFT JOIN public.identity_account_profile p ON p.account_id = a.id
          WHERE a.id = $1`,
        [accountId],
      );
      if (!result.rowCount)
        throw new NotFoundException(pythonKeyErrorDetail(accountId));
      const image = result.rows[0];
      imageId = image.profile_image_id;
      if (!imageId || image.profile_image_media_type !== 'image/webp') {
        throw new NotFoundException(
          pythonKeyErrorDetail('profile image not found'),
        );
      }
    } finally {
      client.release();
    }

    try {
      const response = await this.s3().send(
        new GetObjectCommand({
          Bucket: this.bucket(),
          Key: this.objectKey(accountId, imageId),
        }),
      );
      if (!response.Body) throw new Error('profile image body is missing');
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > MAX_OUTPUT_BYTES) {
          throw new ServiceUnavailableException(
            'stored profile image exceeds its size limit',
          );
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, total);
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }
      if (isMissingObject(error)) {
        throw new NotFoundException(
          pythonKeyErrorDetail('profile image not found'),
        );
      }
      throw new ServiceUnavailableException(
        'profile image storage is unavailable',
      );
    }
  }

  async uploadOwnProfileImage(
    authorization: string | undefined,
    contentType: string | undefined,
    contentLength: string | undefined,
    input: AsyncIterable<Uint8Array>,
  ): Promise<Record<string, unknown>> {
    const content = await readProfileImageBody(input, contentLength);
    const actor = await this.auth.currentAccount(authorization ?? '');
    const actorId = accountIdOf(actor);
    const normalized = await this.normalize(contentType, content);
    const imageId = randomUUID();
    const client = await this.connect();
    let previousImageId: string | null = null;
    let uploaded = false;
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT id FROM public.account WHERE id = $1 FOR UPDATE',
        [actorId],
      );
      const previous = await client.query<{ profile_image_id: string | null }>(
        `SELECT profile_image_id FROM public.identity_account_profile
          WHERE account_id = $1 FOR UPDATE`,
        [actorId],
      );
      previousImageId = previous.rows[0]?.profile_image_id ?? null;
      await this.s3().send(
        new PutObjectCommand({
          Bucket: this.bucket(),
          Key: this.objectKey(actorId, imageId),
          Body: normalized,
          ContentType: 'image/webp',
          CacheControl: 'private, no-store',
        }),
      );
      uploaded = true;
      const updatedAtResult = await client.query<{ updated_at: string }>(
        `INSERT INTO public.identity_account_profile
           (account_id, profile_image_id, profile_image_media_type,
            profile_image_updated_at)
         VALUES ($1, $2, 'image/webp', clock_timestamp())
         ON CONFLICT (account_id) DO UPDATE SET
           profile_image_id = EXCLUDED.profile_image_id,
           profile_image_media_type = EXCLUDED.profile_image_media_type,
           profile_image_updated_at = EXCLUDED.profile_image_updated_at
         RETURNING to_char(profile_image_updated_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`,
        [actorId, imageId],
      );
      await client.query(
        'UPDATE public.account SET updated_at = clock_timestamp() WHERE id = $1',
        [actorId],
      );
      const profileImage = {
        id: imageId,
        contentType: 'image/webp',
        width: OUTPUT_DIMENSION,
        height: OUTPUT_DIMENSION,
        updatedAt: updatedAtResult.rows[0].updated_at,
      };
      await writeSecurityEvent(client, 'identity.profile-image.updated.v1', {
        accountId: actorId,
        actorId,
        profileImage,
      });
      await client.query('COMMIT');
      if (previousImageId)
        this.deleteObjectBestEffort(actorId, previousImageId);
      return { profileImage };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (uploaded) this.deleteObjectBestEffort(actorId, imageId);
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteOwnProfileImage(
    authorization: string,
  ): Promise<{ profileImage: null }> {
    const actor = await this.auth.currentAccount(authorization);
    const actorId = accountIdOf(actor);
    const client = await this.connect();
    let previousImageId: string | null = null;
    try {
      await client.query('BEGIN');
      const account = await client.query(
        'SELECT id FROM public.account WHERE id = $1 FOR UPDATE',
        [actorId],
      );
      if (!account.rowCount) throw new NotFoundException('account not found');
      const previous = await client.query<{ profile_image_id: string | null }>(
        `SELECT profile_image_id FROM public.identity_account_profile
          WHERE account_id = $1 FOR UPDATE`,
        [actorId],
      );
      previousImageId = previous.rows[0]?.profile_image_id ?? null;
      await client.query(
        `INSERT INTO public.identity_account_profile
           (account_id, profile_image_id, profile_image_media_type,
            profile_image_updated_at)
         VALUES ($1, NULL, NULL, NULL)
         ON CONFLICT (account_id) DO UPDATE SET
           profile_image_id = NULL,
           profile_image_media_type = NULL,
           profile_image_updated_at = NULL`,
        [actorId],
      );
      await client.query(
        'UPDATE public.account SET updated_at = now() WHERE id = $1',
        [actorId],
      );
      await writeSecurityEvent(client, 'identity.profile-image.deleted.v1', {
        accountId: actorId,
        actorId,
      });
      await client.query('COMMIT');
      if (previousImageId)
        this.deleteObjectBestEffort(actorId, previousImageId);
      return { profileImage: null };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async authorizeTarget(authorization: string, accountId: string) {
    const actor = await this.auth.currentAccount(authorization);
    const actorId = accountIdOf(actor);
    const scopes = new Set(actor.scopes as string[]);
    if (
      actorId !== accountId &&
      !scopes.has('identity.admin') &&
      !scopes.has('*')
    ) {
      throw new ForbiddenException('profile image access is not permitted');
    }
  }

  private async normalize(
    contentType: string | undefined,
    content: Buffer,
  ): Promise<Buffer> {
    const mediaType = trimPythonWhitespace(
      (contentType ?? '').split(';', 1)[0],
    );
    const format = INPUT_FORMATS[mediaType];
    if (!format) {
      throw new BadRequestException('profile image must be JPEG, PNG, or WebP');
    }
    try {
      const metadata = await sharp(content, { pages: -1 }).metadata();
      if (metadata.format !== format) {
        throw new BadRequestException(
          'profile image content does not match its media type',
        );
      }
      if ((metadata.pages ?? 1) !== 1) {
        throw new BadRequestException(
          'animated profile images are not supported',
        );
      }
      if (format === 'png' && hasAnimatedPng(content)) {
        throw new BadRequestException(
          'animated profile images are not supported',
        );
      }
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width > MAX_INPUT_DIMENSION ||
        metadata.height > MAX_INPUT_DIMENSION
      ) {
        throw new BadRequestException(
          'profile image dimensions exceed 4096 pixels',
        );
      }

      for (const quality of [85, 75, 65, 55]) {
        const output = await sharp(content, {
          limitInputPixels: MAX_INPUT_DIMENSION * MAX_INPUT_DIMENSION,
          animated: false,
          ignoreIcc: true,
        })
          .rotate()
          .resize(OUTPUT_DIMENSION, OUTPUT_DIMENSION, {
            fit: 'cover',
            kernel: sharp.kernel.lanczos3,
            position: 'centre',
          })
          .webp({
            quality,
            alphaQuality: 100,
            effort: 4,
            preset: 'default',
            lossless: false,
            nearLossless: false,
            exact: false,
            smartSubsample: false,
          })
          .toBuffer();
        if (output.byteLength <= MAX_OUTPUT_BYTES) return output;
      }
      throw new BadRequestException('normalized profile image exceeds 256 KiB');
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        'profile image is malformed or unsupported',
      );
    }
  }

  private s3(): S3Client {
    if (this.s3Client) return this.s3Client;
    const accessKeyId = process.env.MYOTA_PROFILE_IMAGE_ACCESS_KEY ?? '';
    const secretAccessKey = process.env.MYOTA_PROFILE_IMAGE_SECRET_KEY ?? '';
    if (!accessKeyId || !secretAccessKey) {
      throw new ServiceUnavailableException(
        'profile image storage credentials are unavailable',
      );
    }
    this.s3Client = new S3Client({
      endpoint:
        process.env.MYOTA_OBJECT_STORAGE_ENDPOINT ?? 'http://seaweedfs:8333',
      region: process.env.MYOTA_OBJECT_STORAGE_REGION ?? 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    return this.s3Client;
  }

  private bucket(): string {
    return (
      process.env.MYOTA_PROFILE_IMAGE_BUCKET ?? 'myota-user-profile-images'
    );
  }

  private objectKey(accountId: string, imageId: string): string {
    return `profiles/${accountId}/${imageId}.webp`;
  }

  deleteObjectBestEffort(accountId: string, imageId: string) {
    try {
      void this.s3()
        .send(
          new DeleteObjectCommand({
            Bucket: this.bucket(),
            Key: this.objectKey(accountId, imageId),
          }),
        )
        .catch(() => undefined);
    } catch {
      // Storage cleanup is best effort; the source has a later orphan sweep.
    }
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool) {
      throw new ServiceUnavailableException(
        'Identity database is not configured',
      );
    }
    try {
      return await this.pool.connect();
    } catch {
      throw new ServiceUnavailableException('Identity database is unavailable');
    }
  }
}

async function readProfileImageBody(
  input: AsyncIterable<Uint8Array>,
  contentLength: string | undefined,
): Promise<Buffer> {
  const normalizedLength = trimPythonWhitespace(contentLength ?? '0');
  if (!/^[+-]?\d(?:_?\d)*$/.test(normalizedLength))
    throw new BadRequestException('invalid Content-Length');
  const declaredLength = BigInt(normalizedLength.replaceAll('_', ''));
  if (declaredLength <= 0n)
    throw new BadRequestException('request body is required');
  if (declaredLength > BigInt(MAX_INPUT_BYTES))
    throw new HttpException(
      { detail: 'profile image upload exceeds 5 MiB' },
      413,
    );

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of input) {
      const part = Buffer.from(chunk);
      size += part.length;
      if (size > MAX_INPUT_BYTES)
        throw new HttpException(
          { detail: 'profile image upload exceeds 5 MiB' },
          413,
        );
      chunks.push(part);
    }
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw new BadRequestException('request body is incomplete');
  }
  if (BigInt(size) !== declaredLength)
    throw new BadRequestException('request body is incomplete');
  return Buffer.concat(chunks, size);
}

function isMissingObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('$metadata' in error) {
    const metadata = error.$metadata as { httpStatusCode?: number };
    if (metadata.httpStatusCode === 404) return true;
  }
  return (
    'name' in error && ['NoSuchKey', 'NotFound'].includes(String(error.name))
  );
}

function hasAnimatedPng(content: Buffer): boolean {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    content.length < signature.length ||
    !content.subarray(0, 8).equals(signature)
  )
    return false;

  let animationFrames: number | undefined;
  let hasFrameControl = false;
  let offset = signature.length;
  while (offset + 12 <= content.length) {
    const length = content.readUInt32BE(offset);
    if (length > content.length - offset - 12) return false;
    const chunkType = content.toString('ascii', offset + 4, offset + 8);
    if (chunkType === 'acTL') {
      if (length < 8) return false;
      animationFrames = content.readUInt32BE(offset + 8);
      if (animationFrames === 0) return false;
    } else if (chunkType === 'fcTL') {
      hasFrameControl = true;
    } else if (chunkType === 'IDAT') {
      return (
        animationFrames !== undefined &&
        (animationFrames > 1 || !hasFrameControl)
      );
    } else if (chunkType === 'IEND') {
      return false;
    }
    offset += length + 12;
  }
  return false;
}

function accountIdOf(actor: Record<string, unknown>): string {
  if (typeof actor.id !== 'string') {
    throw new UnauthorizedException('account identity is unavailable');
  }
  return actor.id;
}
