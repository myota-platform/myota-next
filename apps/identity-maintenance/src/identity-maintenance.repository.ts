import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { integerSetting } from '@app/platform/integer-setting.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class IdentityMaintenanceRepository {
  private readonly logger = new Logger(IdentityMaintenanceRepository.name);
  private storage?: S3Client;

  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async runSweep(): Promise<{
    databaseRecordsRemoved: number;
    profileImagesRemoved: number;
  }> {
    const databaseRecordsRemoved = await this.removeExpiredRecords();
    let profileImagesRemoved = 0;
    try {
      profileImagesRemoved = await this.removeOrphanProfileImages();
    } catch (error) {
      const errorType = error instanceof Error ? error.name : 'UnknownError';
      this.logger.warn(`Identity profile image cleanup failed: ${errorType}`);
    }
    return { databaseRecordsRemoved, profileImagesRemoved };
  }

  private async removeExpiredRecords(): Promise<number> {
    const client = await this.connect();
    const refreshSeconds = integerSetting(
      process.env.MYOTA_REFRESH_TOKEN_SECONDS,
      30 * 86400,
    );
    const securityRetentionSeconds = integerSetting(
      process.env.MYOTA_SECURITY_EVENT_RETENTION_SECONDS,
      365 * 86400,
    );
    try {
      await client.query('BEGIN');
      let removed = 0;
      removed +=
        (
          await client.query(
            `DELETE FROM public.account_recovery_token WHERE used_at IS NOT NULL OR expires_at<=now()`,
          )
        ).rowCount ?? 0;
      removed +=
        (
          await client.query(
            `DELETE FROM public.auth_session WHERE revoked_at IS NOT NULL
           AND revoked_at<now()-make_interval(secs=>$1)`,
            [refreshSeconds],
          )
        ).rowCount ?? 0;
      removed +=
        (
          await client.query(
            'DELETE FROM public.auth_revocation WHERE expires_at<=now()',
          )
        ).rowCount ?? 0;
      removed +=
        (
          await client.query(
            'DELETE FROM public.identity_login_rate_limit WHERE expires_at<=now()',
          )
        ).rowCount ?? 0;
      removed +=
        (
          await client.query(
            `DELETE FROM public.security_event WHERE occurred_at<now()-make_interval(secs=>$1)`,
            [securityRetentionSeconds],
          )
        ).rowCount ?? 0;
      await client.query('COMMIT');
      return removed;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async removeOrphanProfileImages(): Promise<number> {
    const graceSeconds = Math.max(
      3600,
      integerSetting(
        process.env.MYOTA_PROFILE_IMAGE_ORPHAN_GRACE_SECONDS,
        86400,
      ),
    );
    const client = await this.connect();
    let referenced: Set<string>;
    try {
      const result = await client.query(
        `SELECT p.account_id::text,p.profile_image_id::text
         FROM public.identity_account_profile p
         JOIN public.account a ON a.id=p.account_id
         WHERE p.profile_image_id IS NOT NULL`,
      );
      referenced = new Set(
        result.rows.map((row) => `${row.account_id}:${row.profile_image_id}`),
      );
    } finally {
      client.release();
    }

    const cutoff = Date.now() - graceSeconds * 1000;
    const bucket =
      process.env.MYOTA_PROFILE_IMAGE_BUCKET ?? 'myota-user-profile-images';
    let token: string | undefined;
    let removed = 0;
    do {
      const page = await this.s3().send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: 'profiles/',
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) {
        const key = object.Key ?? '';
        const parts = key.split('/');
        if (
          parts.length !== 3 ||
          parts[0] !== 'profiles' ||
          !UUID.test(parts[1]) ||
          !parts[2].endsWith('.webp') ||
          !UUID.test(parts[2].slice(0, -5)) ||
          !(object.LastModified instanceof Date) ||
          object.LastModified.getTime() > cutoff
        )
          continue;
        if (referenced.has(`${parts[1]}:${parts[2].slice(0, -5)}`)) continue;
        await this.s3().send(
          new DeleteObjectCommand({ Bucket: bucket, Key: key }),
        );
        removed++;
      }
      if (page.IsTruncated && !page.NextContinuationToken)
        throw new Error('profile image listing omitted its continuation token');
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return removed;
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool)
      throw new ServiceUnavailableException('Core database is not configured');
    return this.pool.connect();
  }

  private s3(): S3Client {
    if (this.storage) return this.storage;
    const accessKeyId = process.env.MYOTA_PROFILE_IMAGE_ACCESS_KEY ?? '';
    const secretAccessKey = process.env.MYOTA_PROFILE_IMAGE_SECRET_KEY ?? '';
    if (!accessKeyId || !secretAccessKey)
      throw new ServiceUnavailableException(
        'profile image storage credentials are unavailable',
      );
    this.storage = new S3Client({
      endpoint:
        process.env.MYOTA_OBJECT_STORAGE_ENDPOINT ?? 'http://seaweedfs:8333',
      region: process.env.MYOTA_OBJECT_STORAGE_REGION ?? 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    return this.storage;
  }
}
