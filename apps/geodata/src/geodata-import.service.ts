import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';

const adapters = new Set(['PARKSERVE_US', 'OSM', 'GOVERNMENT_GIS', 'MANUAL']);
const entityTypePattern = /^[A-Z][A-Z0-9_]{1,63}$/;

@Injectable()
export class GeodataImportService {
  private storage: S3Client | undefined;

  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async create(key: string | undefined, body: Record<string, unknown>) {
    const prepared = prepareImport(await this.resolveObjectReference(body));
    const bucket =
      process.env.MYOTA_GEODATA_IMPORT_BUCKET ?? 'myota-geodata-imports';
    const id = randomUUID();
    const objectKey = `geodata/imports/${id}/source.geojson`;
    const raw = Buffer.from(JSON.stringify(prepared.document));
    const sourceHash = createHash('sha256').update(raw).digest('hex');
    const client = await this.connect();
    let uploaded = false;
    try {
      await client.query('BEGIN');
      if (key) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('geodata-service:' || $1,0))",
          [key],
        );
        const previous = await client.query(
          'SELECT response FROM idempotency_record WHERE service=$1 AND key=$2',
          ['geodata-service', key],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return previous.rows[0].response;
        }
      }

      await this.s3().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: raw,
          ContentType: 'application/geo+json',
          Metadata: { sha256: sourceHash },
        }),
      );
      uploaded = true;
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      const metadata = {
        source: prepared.source,
        entityTypes: prepared.entityTypes,
        filename: prepared.filename,
        format: 'GEOJSON',
        programmeSlug: prepared.programmeSlug,
        completeSnapshot: prepared.completeSnapshot,
        disappearancePolicy: prepared.disappearancePolicy,
        sourceObject: { bucket, key: objectKey },
        featureCount: prepared.features.length,
      };
      await client.query(
        `INSERT INTO import_run
          (id,adapter_code,source_metadata,status,programme_id,source_key,source_hash,stats,
           complete_snapshot,disappearance_policy)
         VALUES ($1,$2,$3::jsonb,'QUEUED',NULL,$4,$5,$6::jsonb,$7,$8)`,
        [
          id,
          prepared.adapter,
          JSON.stringify(metadata),
          objectKey,
          sourceHash,
          JSON.stringify({ featureCount: prepared.features.length }),
          prepared.completeSnapshot,
          prepared.disappearancePolicy,
        ],
      );
      const response = {
        ...metadata,
        id,
        adapter: prepared.adapter,
        format: 'GEOJSON',
        status: 'QUEUED',
        queued: true,
        startedAt: new Date().toISOString(),
        stats: { featureCount: prepared.features.length },
        sourceHash,
      };
      await client.query(
        `INSERT INTO outbox_event
          (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
         VALUES ($1,'geodata.import.queued.v1','geodata-service','import_run',$2,$3::jsonb,now(),$4)`,
        [
          randomUUID(),
          id,
          JSON.stringify({
            importRunId: id,
            programmeSlug: prepared.programmeSlug,
            adapter: prepared.adapter,
            format: 'GEOJSON',
            entityType: prepared.entityTypes[0],
            entityTypes: prepared.entityTypes,
            filename: prepared.filename,
            natsSubject: 'myota.geodata.import.preprocess.v1',
          }),
          randomUUID(),
        ],
      );
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          ['geodata-service', key, JSON.stringify(response)],
        );
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (uploaded)
        await this.s3()
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }))
          .catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async resolveObjectReference(body: Record<string, unknown>) {
    if (!isRecord(body.source) || typeof body.source.objectKey !== 'string')
      return body;
    const bucket =
      process.env.MYOTA_GEODATA_IMPORT_BUCKET ?? 'myota-geodata-imports';
    const requestedBucket =
      typeof body.source.bucket === 'string' ? body.source.bucket : bucket;
    const objectKey = body.source.objectKey;
    if (
      requestedBucket !== bucket ||
      !objectKey.trim() ||
      objectKey.includes('..') ||
      objectKey.includes('\\')
    )
      throw new BadRequestException(
        'source object must belong to the configured Geodata import bucket',
      );
    const filename =
      typeof body.filename === 'string' ? body.filename.slice(0, 255) : '';
    if (!filename)
      throw new BadRequestException(
        'filename is required for an object reference',
      );
    try {
      const head = await this.s3().send(
        new HeadObjectCommand({ Bucket: bucket, Key: objectKey }),
      );
      if (!Number.isSafeInteger(head.ContentLength) || head.ContentLength! < 1)
        throw new BadRequestException(
          'source object is empty or has an invalid size',
        );
      if (head.ContentLength! > 20 * 1024 * 1024)
        throw new BadRequestException(
          'source object exceeds the 20 MiB import limit',
        );
      const result = await this.s3().send(
        new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
      );
      if (!result.Body)
        throw new BadRequestException('source object has no content');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 20 * 1024 * 1024)
          throw new BadRequestException(
            'source object exceeds the 20 MiB import limit',
          );
        chunks.push(bytes);
      }
      const content = Buffer.concat(chunks);
      if (size !== head.ContentLength)
        throw new BadRequestException(
          'source object changed while it was being read',
        );
      const sha256 = createHash('sha256').update(content).digest('hex');
      if (
        typeof body.source.sha256 === 'string' &&
        body.source.sha256.toLowerCase() !== sha256
      )
        throw new BadRequestException(
          'source object checksum does not match sha256',
        );
      return { ...body, content: content.toString('utf8') };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        'source object was not found or could not be read',
      );
    }
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
}

function prepareImport(body: Record<string, unknown>) {
  const adapter = (typeof body.adapter === 'string' ? body.adapter : '')
    .trim()
    .toUpperCase();
  if (!adapters.has(adapter))
    throw new BadRequestException('unsupported import adapter');
  const format = (typeof body.format === 'string' ? body.format : 'GEOJSON')
    .trim()
    .toUpperCase();
  if (format !== 'GEOJSON')
    throw new BadRequestException(
      'this import endpoint currently accepts GEOJSON only',
    );
  const source = body.source;
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw new BadRequestException('source must be an object');

  const rawTypes = body.entityTypes ?? body.entityTypeCodes ?? body.entityType;
  const entityTypes = (Array.isArray(rawTypes) ? rawTypes : [rawTypes])
    .map((value) =>
      String(value ?? '')
        .trim()
        .toUpperCase(),
    )
    .filter(Boolean);
  if (
    !entityTypes.length ||
    entityTypes.some((value) => !entityTypePattern.test(value))
  )
    throw new BadRequestException('one or more valid entityTypes are required');
  if (new Set(entityTypes).size !== entityTypes.length)
    throw new BadRequestException('entityTypes must be unique');
  const disappearancePolicy =
    typeof body.disappearancePolicy === 'string'
      ? body.disappearancePolicy.toUpperCase()
      : 'REVIEW_REQUIRED';
  if (
    !['UNCHANGED', 'STALE', 'RETIRED', 'REVIEW_REQUIRED'].includes(
      disappearancePolicy,
    )
  )
    throw new BadRequestException('unsupported disappearancePolicy');
  if (body.completeSnapshot === true)
    throw new BadRequestException(
      'complete snapshot reconciliation is not available for this import path yet',
    );

  let document: Record<string, unknown>;
  if (Array.isArray(body.features)) {
    document = { type: 'FeatureCollection', features: body.features };
  } else if (typeof body.content === 'string') {
    try {
      const parsed: unknown = JSON.parse(body.content);
      if (!isRecord(parsed)) throw new Error('expected an object');
      document = parsed;
    } catch {
      throw new BadRequestException('GEOJSON content must be valid JSON');
    }
  } else {
    throw new BadRequestException('features or GEOJSON content is required');
  }
  let features: unknown[];
  if (
    document.type === 'FeatureCollection' &&
    Array.isArray(document.features)
  ) {
    features = document.features;
  } else if (document.type === 'Feature') {
    features = [document];
    document = { type: 'FeatureCollection', features };
  } else {
    throw new BadRequestException(
      'GEOJSON must be a Feature or FeatureCollection',
    );
  }
  if (
    !features.length ||
    features.some((feature) => !isRecord(feature) || feature.type !== 'Feature')
  )
    throw new BadRequestException(
      'GEOJSON features must be non-empty Feature objects',
    );
  const maxFeatures = boundedInteger(
    process.env.GEODATA_MAX_IMPORT_FEATURES,
    5000,
  );
  if (features.length > maxFeatures)
    throw new BadRequestException(
      `an import may contain at most ${maxFeatures} features`,
    );
  return {
    adapter,
    source: source as Record<string, unknown>,
    entityTypes,
    filename:
      typeof body.filename === 'string' ? body.filename.slice(0, 255) : null,
    programmeSlug:
      typeof body.programmeSlug === 'string'
        ? body.programmeSlug.trim() || null
        : null,
    completeSnapshot: body.completeSnapshot === true,
    disappearancePolicy,
    document,
    features,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 100000
    ? parsed
    : fallback;
}
