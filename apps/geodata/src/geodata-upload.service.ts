import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Pool } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import {
  MAX_GEOJSON_UPLOAD_BYTES,
  MAX_OSM_PBF_UPLOAD_BYTES,
  MAX_SHAPEFILE_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
} from '@app/platform/import-limits.js';
import { integerSetting } from '@app/platform/integer-setting.js';
import { normalizePythonNumericText } from '@app/platform/python-numeric.js';
import { normalizeEntityTypeCodes } from './geodata-entity-types.js';

export const MAX_UPLOAD_PART_BYTES = integerEnv(
  'MYOTA_UPLOAD_PART_MAX_BYTES',
  16 * 1024 * 1024,
);

@Injectable()
export class GeodataUploadService {
  private storage: S3Client | undefined;

  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async create(
    owner: string,
    key: string | undefined,
    body: Record<string, unknown>,
  ) {
    const input = validateCreate(body);
    const idempotencyKey = key || randomUUID();
    const bucket =
      process.env.MYOTA_GEODATA_IMPORT_BUCKET ?? 'myota-geodata-imports';
    const id = randomUUID();
    const objectKey = `geodata-imports/${id}-${input.filename}`;
    const client = await this.connect();
    try {
      const prior = await client.query(
        `SELECT id::text, filename, expected_size, status FROM geodata_upload_session
         WHERE owner_subject=$1 AND idempotency_key=$2`,
        [owner, idempotencyKey],
      );
      if (prior.rows[0]) return this.createdResponse(prior.rows[0], input);

      const created = await this.s3().send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: objectKey,
          ContentType: 'application/octet-stream',
        }),
      );
      if (!created.UploadId)
        throw new ServiceUnavailableException(
          'Object storage did not create an upload',
        );
      try {
        const result = await client.query(
          `INSERT INTO geodata_upload_session
           (id,owner_subject,idempotency_key,filename,metadata,bucket,object_key,multipart_upload_id,
            expected_size,expected_sha256,status,expires_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,'UPLOADING',now()+interval '24 hours')
           ON CONFLICT (owner_subject,idempotency_key) DO NOTHING
           RETURNING id::text,filename,expected_size,status`,
          [
            id,
            owner,
            idempotencyKey,
            input.filename,
            stringifyJsonWithBigInts(input.metadata),
            bucket,
            objectKey,
            created.UploadId,
            input.expectedSize,
            input.sha256,
          ],
        );
        if (result.rows[0]) return this.createdResponse(result.rows[0], input);
        const raced = await client.query(
          `SELECT id::text,filename,expected_size,status FROM geodata_upload_session
           WHERE owner_subject=$1 AND idempotency_key=$2`,
          [owner, idempotencyKey],
        );
        if (!raced.rows[0])
          throw new Error('idempotent upload insert lost without a winner');
        await this.s3().send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: objectKey,
            UploadId: created.UploadId,
          }),
        );
        return this.createdResponse(raced.rows[0], input);
      } catch (error) {
        await this.s3()
          .send(
            new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: objectKey,
              UploadId: created.UploadId,
            }),
          )
          .catch(() => undefined);
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async get(owner: string, id: string) {
    const client = await this.connect();
    try {
      const session = await this.findSession(client, id, owner, false, true);
      const parts = await client.query(
        `SELECT part_number,size_bytes,sha256 FROM geodata_upload_part
         WHERE upload_session_id=$1 ORDER BY part_number`,
        [id],
      );
      return {
        uploadId: id,
        status: session.status,
        filename: session.filename,
        expectedSize: Number(session.expected_size),
        importRunId: session.import_run_id,
        parts: (session.status === 'COMPLETED' ? [] : parts.rows).map(
          (part) => ({
            partNumber: part.part_number,
            sizeBytes: Number(part.size_bytes),
            sha256: part.sha256,
          }),
        ),
      };
    } finally {
      client.release();
    }
  }

  async uploadPart(
    owner: string,
    id: string,
    partNumber: number,
    body: Buffer,
    declared?: string,
  ) {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000)
      throw new BadRequestException('partNumber must be between 1 and 10000');
    if (
      !Buffer.isBuffer(body) ||
      body.length === 0 ||
      body.length > MAX_UPLOAD_PART_BYTES
    )
      throw new BadRequestException(
        `upload part must be between 1 and ${MAX_UPLOAD_PART_BYTES} bytes`,
      );
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (declared && declared.toLowerCase() !== sha256)
      throw new BadRequestException('upload part checksum does not match');
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,$2))',
        [id, partNumber],
      );
      const session = await this.findSession(client, id, owner, true);
      const total = await client.query(
        `SELECT COALESCE(sum(size_bytes),0)::bigint AS bytes FROM geodata_upload_part
         WHERE upload_session_id=$1 AND part_number<>$2`,
        [id, partNumber],
      );
      if (
        Number(total.rows[0].bytes) + body.length >
        Number(session.expected_size)
      )
        throw new BadRequestException(
          'uploaded parts exceed the declared upload size',
        );
      const result = await this.s3().send(
        new UploadPartCommand({
          Bucket: session.bucket,
          Key: session.object_key,
          UploadId: session.multipart_upload_id,
          PartNumber: partNumber,
          Body: body,
        }),
      );
      if (!result.ETag)
        throw new ServiceUnavailableException(
          'Object storage returned no part ETag',
        );
      await client.query(
        `INSERT INTO geodata_upload_part(upload_session_id,part_number,size_bytes,sha256,etag)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (upload_session_id,part_number)
         DO UPDATE SET size_bytes=EXCLUDED.size_bytes,sha256=EXCLUDED.sha256,etag=EXCLUDED.etag,uploaded_at=now()`,
        [id, partNumber, body.length, sha256, result.ETag],
      );
      await client.query('COMMIT');
      return {
        uploadId: id,
        partNumber,
        sizeBytes: body.length,
        sha256,
        etag: result.ETag,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(owner: string, id: string) {
    const client = await this.connect();
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [id]);
    try {
      await client.query('BEGIN');
      const session = await this.findSession(client, id, owner, true, true);
      if (session.status === 'COMPLETED') {
        await client.query('COMMIT');
        return {
          uploadId: id,
          status: 'COMPLETED',
          importRunId: session.import_run_id,
        };
      }
      if (session.status !== 'UPLOADING' && session.status !== 'COMPLETING')
        throw new ConflictException(
          `upload session is ${String(session.status).toLowerCase()}`,
        );
      const rows = await client.query(
        `SELECT part_number,size_bytes,sha256,etag FROM geodata_upload_part
         WHERE upload_session_id=$1 ORDER BY part_number`,
        [id],
      );
      const parts = rows.rows;
      if (
        !parts.length ||
        parts.some((p, i) => Number(p.part_number) !== i + 1)
      )
        throw new BadRequestException(
          'upload parts must be contiguous and start at 1',
        );
      const size = parts.reduce(
        (sum, part) => sum + Number(part.size_bytes),
        0,
      );
      if (size !== Number(session.expected_size))
        throw new BadRequestException(
          'uploaded byte total does not match expectedSize',
        );
      if (
        parts.slice(0, -1).some((p) => Number(p.size_bytes) < 5 * 1024 * 1024)
      )
        throw new BadRequestException(
          'all multipart upload parts except the last must be at least 5 MiB',
        );
      await client.query(
        `UPDATE geodata_upload_session SET status='COMPLETING',updated_at=now()
         WHERE id=$1 AND status='UPLOADING'`,
        [id],
      );
      await client.query('COMMIT');

      try {
        await this.s3().send(
          new CompleteMultipartUploadCommand({
            Bucket: session.bucket,
            Key: session.object_key,
            UploadId: session.multipart_upload_id,
            MultipartUpload: {
              Parts: parts.map((p) => ({
                PartNumber: p.part_number,
                ETag: p.etag,
              })),
            },
          }),
        );
      } catch (error) {
        // A prior request may have completed S3 but lost its response.
        const head = await this.s3()
          .send(
            new HeadObjectCommand({
              Bucket: session.bucket,
              Key: session.object_key,
            }),
          )
          .catch(() => undefined);
        if (Number(head?.ContentLength) !== Number(session.expected_size))
          throw error;
      }
      const metadata = session.metadata as Record<string, unknown>;
      const format =
        typeof metadata.format === 'string'
          ? metadata.format.toUpperCase()
          : '';
      const sourceLimit = sourceUploadLimit(format);
      const scan = await this.scanObject(
        session.bucket,
        session.object_key,
        Number(session.expected_size),
        sourceLimit,
      );
      if (session.expected_sha256 && scan.sha256 !== session.expected_sha256)
        throw new BadRequestException(
          'completed object checksum does not match sha256',
        );
      const source = {
        ...(metadata.source as Record<string, unknown>),
        bucket: session.bucket,
        objectKey: session.object_key,
        sha256: scan.sha256,
        size: scan.size,
        scan: { status: 'CLEAN' },
      };
      const importMetadata = {
        ...metadata,
        source,
        sourceObject: { bucket: session.bucket, key: session.object_key },
      };
      const run = await this.connect();
      try {
        await run.query('BEGIN');
        await run.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        await run.query(
          `INSERT INTO import_run
           (id,adapter_code,source_metadata,status,programme_id,source_key,source_hash,stats,complete_snapshot,disappearance_policy)
           VALUES ($1,$2,$3::jsonb,'QUEUED',NULL,$4,$5,'{}'::jsonb,false,'REVIEW_REQUIRED')
           ON CONFLICT (id) DO NOTHING`,
          [
            id,
            metadata.adapter,
            stringifyJsonWithBigInts(importMetadata),
            session.object_key,
            scan.sha256,
          ],
        );
        await run.query(
          `INSERT INTO outbox_event(event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
           SELECT $1,'geodata.import.queued.v1','geodata-service','import_run',$2,$3::jsonb,now(),$4
           WHERE NOT EXISTS (SELECT 1 FROM outbox_event WHERE event_type='geodata.import.queued.v1' AND aggregate_id=$2)`,
          [
            randomUUID(),
            id,
            stringifyJsonWithBigInts({
              importRunId: id,
              uploadId: id,
              filename: session.filename,
              adapter: metadata.adapter,
              format: metadata.format,
              entityTypes: metadata.entityTypes,
              natsSubject: 'myota.geodata.import.preprocess.v1',
            }),
            randomUUID(),
          ],
        );
        await run.query(
          `UPDATE geodata_upload_session SET status='COMPLETED',import_run_id=$2,completed_at=now(),updated_at=now()
           WHERE id=$1`,
          [id, id],
        );
        await run.query('COMMIT');
      } catch (error) {
        await run.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        run.release();
      }
      return {
        uploadId: id,
        status: 'COMPLETED',
        importRun: {
          id,
          ...importMetadata,
          status: 'QUEUED',
          sourceHash: scan.sha256,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [id])
        .catch(() => undefined);
      client.release();
    }
  }

  async abort(owner: string, id: string) {
    const client = await this.connect();
    try {
      const session = await this.findSession(client, id, owner);
      if (session.status === 'COMPLETED')
        throw new ConflictException('completed upload cannot be aborted');
      if (session.status !== 'ABORTED') {
        await this.s3()
          .send(
            new AbortMultipartUploadCommand({
              Bucket: session.bucket,
              Key: session.object_key,
              UploadId: session.multipart_upload_id,
            }),
          )
          .catch(() => undefined);
        await client.query(
          "UPDATE geodata_upload_session SET status='ABORTED',updated_at=now() WHERE id=$1",
          [id],
        );
      }
      return { uploadId: id, status: 'ABORTED' };
    } finally {
      client.release();
    }
  }

  private async scanObject(
    bucket: string,
    key: string,
    expectedSize: number,
    sourceLimit: number,
  ) {
    if (expectedSize > sourceLimit)
      throw new BadRequestException(
        'upload exceeds the configured upload limit',
      );
    const result = await this.s3().send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!result.Body)
      throw new ServiceUnavailableException(
        'Object storage returned no object body',
      );
    const hash = createHash('sha256');
    const marker = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    let carry = Buffer.alloc(0);
    let size = 0;
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      hash.update(bytes);
      const scan = Buffer.concat([carry, bytes]);
      if (scan.includes(marker)) {
        await this.s3()
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
          .catch(() => undefined);
        throw new BadRequestException('malware scan rejected the upload');
      }
      carry = scan.subarray(Math.max(0, scan.length - marker.length + 1));
    }
    if (size !== expectedSize)
      throw new BadRequestException(
        'completed object size does not match expectedSize',
      );
    const scannerUrl = process.env.MYOTA_CLAMAV_URL?.trim();
    if (scannerUrl) {
      const scannedObject = await this.s3().send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      if (!scannedObject.Body)
        throw new ServiceUnavailableException(
          'Object storage returned no object body',
        );
      const stream = Readable.from(
        scannedObject.Body as AsyncIterable<Uint8Array>,
      );
      try {
        const response = await fetch(scannerUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(size),
          },
          body: stream as never,
          duplex: 'half',
        } as RequestInit & { duplex: 'half' });
        if (!response.ok)
          throw new BadRequestException('malware scanner rejected the upload');
      } catch (error) {
        stream.destroy();
        if (error instanceof BadRequestException) throw error;
        throw new ServiceUnavailableException(
          'malware scanner is unavailable; import was not queued',
        );
      }
    }
    return { size, sha256: hash.digest('hex') };
  }

  private async findSession(
    client: import('pg').PoolClient,
    id: string,
    owner: string,
    forUpdate = false,
    allowCompleted = false,
  ) {
    const result = await client.query(
      `SELECT id::text,owner_subject,filename,metadata,bucket,object_key,multipart_upload_id,
       expected_size,expected_sha256,status,import_run_id::text,expires_at
       FROM geodata_upload_session WHERE id=$1 AND owner_subject=$2${forUpdate ? ' FOR UPDATE' : ''}`,
      [id, owner],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('upload session not found');
    if (allowCompleted && row.status === 'COMPLETED') return row;
    if (!['UPLOADING', 'COMPLETING'].includes(row.status))
      throw new ConflictException(
        `upload session is ${String(row.status).toLowerCase()}`,
      );
    if (new Date(row.expires_at).getTime() <= Date.now())
      throw new ConflictException('upload session has expired');
    return row;
  }

  private async connect() {
    if (!this.pool)
      throw new ServiceUnavailableException(
        'Geodata database is not configured',
      );
    try {
      return await this.pool.connect();
    } catch {
      throw new ServiceUnavailableException('Geodata database is unavailable');
    }
  }

  private s3() {
    if (!this.storage)
      this.storage = new S3Client({
        endpoint:
          process.env.MYOTA_OBJECT_STORAGE_ENDPOINT ?? 'http://seaweedfs:8333',
        region: process.env.MYOTA_OBJECT_STORAGE_REGION ?? 'us-east-1',
        forcePathStyle:
          (process.env.MYOTA_OBJECT_STORAGE_ADDRESSING_STYLE ?? 'path') ===
          'path',
        credentials: {
          accessKeyId:
            process.env.MYOTA_OBJECT_STORAGE_ACCESS_KEY ?? 'myota-s3',
          secretAccessKey:
            process.env.MYOTA_OBJECT_STORAGE_SECRET_KEY ?? 'myota-s3-dev-only',
        },
      });
    return this.storage;
  }

  private createdResponse(
    row: Record<string, unknown>,
    input: ReturnType<typeof validateCreate>,
  ) {
    if (
      row.filename !== input.filename ||
      Number(row.expected_size) !== input.expectedSize
    )
      throw new ConflictException(
        'Idempotency-Key was already used for different upload metadata',
      );
    return {
      uploadId: row.id,
      status: row.status,
      partSizeBytes: MAX_UPLOAD_PART_BYTES,
      expiresInSeconds: 86400,
    };
  }
}

export function validateCreate(body: Record<string, unknown>) {
  const adapter = typeof body.adapter === 'string' ? body.adapter : '';
  if (!['PARKSERVE_US', 'OSM', 'GOVERNMENT_GIS', 'MANUAL'].includes(adapter))
    throw new BadRequestException('unsupported import adapter');
  if (
    !body.source ||
    typeof body.source !== 'object' ||
    Array.isArray(body.source)
  )
    throw new BadRequestException('source must be an object');
  const filename =
    typeof body.filename === 'string' ? body.filename.split(/[\\/]/).pop() : '';
  if (!filename) throw new BadRequestException('filename must not be empty');
  const fallbackFormat = filename.slice(filename.lastIndexOf('.') + 1);
  const formatValue =
    typeof body.format === 'string' && body.format
      ? body.format
      : fallbackFormat;
  const format = formatValue.toUpperCase();
  const sourceLimit = sourceUploadLimit(format);
  const parsedExpectedSize = pythonInteger(body.expectedSize);
  if (
    parsedExpectedSize === null ||
    parsedExpectedSize < 1n ||
    parsedExpectedSize > BigInt(sourceLimit)
  )
    throw new BadRequestException(
      `upload size must be between 1 and ${sourceLimit} bytes`,
    );
  const expectedSize = Number(parsedExpectedSize);
  const entityTypes = normalizeEntityTypeCodes(
    body.entityTypes,
    body.entityType,
  );
  if (!entityTypes.length)
    throw new BadRequestException(
      'entityTypes must contain at least one category',
    );
  const sha256 =
    typeof body.sha256 === 'string' ? body.sha256.toLowerCase() : null;
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256))
    throw new BadRequestException(
      'sha256 must be a 64-character hexadecimal digest',
    );
  if (
    ![
      'GEOJSON',
      'KML',
      'GPX',
      'SHAPEFILE',
      'SHP',
      'PARKSERVE_US',
      'OSM_PBF',
    ].includes(format)
  )
    throw new BadRequestException(
      'this import path accepts GeoJSON, KML, GPX, Shapefile ZIP archives, or OSM PBF files',
    );
  const normalizedFormat =
    format === 'SHP' || format === 'PARKSERVE_US' ? 'SHAPEFILE' : format;
  if (normalizedFormat === 'OSM_PBF' && adapter !== 'OSM')
    throw new BadRequestException('OSM PBF imports require the OSM adapter');
  if (
    normalizedFormat === 'SHAPEFILE' &&
    !filename.toLowerCase().endsWith('.zip')
  )
    throw new BadRequestException(
      'Shapefile uploads must be ZIP archives containing .shp, .shx, and .dbf files',
    );
  if (
    normalizedFormat === 'OSM_PBF' &&
    !filename.toLowerCase().endsWith('.pbf')
  )
    throw new BadRequestException('OSM PBF uploads must use a .pbf filename');
  if (filename.length > 255)
    throw new BadRequestException('filename must be at most 255 characters');
  const source =
    body.source &&
    typeof body.source === 'object' &&
    !Array.isArray(body.source)
      ? { ...(body.source as Record<string, unknown>) }
      : body.source;
  if (
    normalizedFormat === 'OSM_PBF' &&
    source &&
    typeof source === 'object' &&
    !Array.isArray(source) &&
    typeof (source as Record<string, unknown>).attribution !== 'string'
  )
    (source as Record<string, unknown>).attribution =
      '© OpenStreetMap contributors';
  const metadata = {
    ...body,
    source,
    adapter,
    format: normalizedFormat,
    filename,
    entityTypes,
  };
  delete (metadata as Record<string, unknown>).expectedSize;
  delete (metadata as Record<string, unknown>).sha256;
  return { filename, expectedSize, sha256, metadata };
}

function integerEnv(name: string, fallback: number) {
  return integerSetting(process.env[name], fallback);
}

function pythonInteger(value: unknown): bigint | null {
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return BigInt(Math.trunc(value));
  }
  if (typeof value !== 'string') return null;
  const normalized = normalizePythonNumericText(value);
  if (!/^[+-]?\d(?:_?\d)*$/.test(normalized)) return null;
  return BigInt(normalized.replaceAll('_', ''));
}

function sourceUploadLimit(format: string) {
  return format === 'OSM_PBF'
    ? MAX_OSM_PBF_UPLOAD_BYTES
    : format === 'GEOJSON'
      ? MAX_GEOJSON_UPLOAD_BYTES
      : format === 'SHAPEFILE' || format === 'SHP' || format === 'PARKSERVE_US'
        ? MAX_SHAPEFILE_UPLOAD_BYTES
        : MAX_UPLOAD_BYTES;
}
