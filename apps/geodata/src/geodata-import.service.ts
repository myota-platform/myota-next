import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
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
import proj4 from 'proj4';
import type { Pool } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import {
  MAX_IMPORT_FEATURES,
  MAX_UPLOAD_BYTES,
} from '@app/platform/import-limits.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import {
  firstPythonTruthy,
  normalizeEntityTypeCodes,
} from './geodata-entity-types.js';
import { parseXmlImport } from './geodata-xml-import.js';
import {
  lockRequest,
  readRequestResponse,
  requestResponse,
} from './geodata-request-idempotency.js';

const adapters = new Set(['PARKSERVE_US', 'OSM', 'GOVERNMENT_GIS', 'MANUAL']);

type ImportOptions = {
  communityProposal?: { proposalId: string; proposerId: string };
  autoPromote?: { requestedBy: string; note: string };
  requestHash?: string;
  rawDocumentJson?: string;
  sourceFeatureHashOverrides?: string[];
};

@Injectable()
export class GeodataImportService {
  private storage: S3Client | undefined;

  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async create(
    key: string | undefined,
    body: Record<string, unknown> | (() => Record<string, unknown>),
    options: ImportOptions = {},
  ) {
    const preparedBeforeTransaction =
      typeof body === 'function' && options.requestHash
        ? undefined
        : prepareImport(
            await this.resolveObjectReference(
              typeof body === 'function' ? body() : body,
            ),
          );
    const bucket =
      process.env.MYOTA_GEODATA_IMPORT_BUCKET ?? 'myota-geodata-imports';
    const client = await this.connect();
    let uploaded = false;
    let objectKey: string | undefined;
    try {
      await client.query('BEGIN');
      if (key) {
        if (options.requestHash) await lockRequest(client, key);
        else
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('geodata-service:' || $1,0))",
            [key],
          );
        const previous = await readRequestResponse(
          client,
          'geodata-service',
          key,
          options.requestHash,
        );
        if (previous.found) {
          await client.query('COMMIT');
          return previous.response;
        }
      }

      const prepared =
        preparedBeforeTransaction ??
        prepareImport(
          await this.resolveObjectReference(
            typeof body === 'function' ? body() : body,
          ),
        );
      const id = randomUUID();
      objectKey = `geodata/imports/${id}/source.geojson`;
      const raw = Buffer.from(
        options.rawDocumentJson ?? stringifyJsonWithBigInts(prepared.document),
      );
      const sourceHash = createHash('sha256').update(raw).digest('hex');

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
      const sourceFeatureHashOverrides =
        options.sourceFeatureHashOverrides?.length === prepared.features.length
          ? options.sourceFeatureHashOverrides
          : undefined;
      const metadata: Record<string, unknown> = {
        source: prepared.source,
        entityTypes: prepared.entityTypes,
        filename: prepared.filename,
        format: 'GEOJSON',
        sourceFormat: prepared.sourceFormat,
        programmeSlug: prepared.programmeSlug,
        completeSnapshot: prepared.completeSnapshot,
        disappearancePolicy: prepared.disappearancePolicy,
        sourceObject: { bucket, key: objectKey },
        featureCount: prepared.features.length,
        ...(options.communityProposal
          ? { communityProposal: options.communityProposal }
          : {}),
        ...(options.autoPromote ? { autoPromote: options.autoPromote } : {}),
        ...(sourceFeatureHashOverrides ? { sourceFeatureHashOverrides } : {}),
      };
      await client.query(
        `INSERT INTO import_run
          (id,adapter_code,source_metadata,status,programme_id,source_key,source_hash,stats,
           complete_snapshot,disappearance_policy)
         VALUES ($1,$2,$3::jsonb,'QUEUED',NULL,$4,$5,$6::jsonb,$7,$8)`,
        [
          id,
          prepared.adapter,
          stringifyJsonWithBigInts(metadata),
          objectKey,
          sourceHash,
          stringifyJsonWithBigInts({ featureCount: prepared.features.length }),
          prepared.completeSnapshot,
          prepared.databaseDisappearancePolicy,
        ],
      );
      const response: Record<string, unknown> = {
        ...metadata,
        ...(options.communityProposal
          ? { proposalId: options.communityProposal.proposalId }
          : {}),
        id,
        adapter: prepared.adapter,
        format: 'GEOJSON',
        status: 'QUEUED',
        queued: true,
        startedAt: new Date().toISOString(),
        stats: { featureCount: prepared.features.length },
        sourceHash,
      };
      delete response.sourceFeatureHashOverrides;
      await client.query(
        `INSERT INTO outbox_event
          (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
         VALUES ($1,'geodata.import.queued.v1','geodata-service','import_run',$2,$3::jsonb,now(),$4)`,
        [
          randomUUID(),
          id,
          stringifyJsonWithBigInts({
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
          [
            'geodata-service',
            key,
            stringifyJsonWithBigInts(
              requestResponse(response, options.requestHash),
            ),
          ],
        );
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (uploaded && objectKey)
        await this.s3()
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }))
          .catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async discardSourceObject(metadata: unknown) {
    if (!isRecord(metadata) || !isRecord(metadata.sourceObject)) return;
    const bucket =
      process.env.MYOTA_GEODATA_IMPORT_BUCKET ?? 'myota-geodata-imports';
    const sourceBucket = metadata.sourceObject.bucket;
    const key = metadata.sourceObject.key;
    if (sourceBucket === bucket && typeof key === 'string' && key)
      await this.s3().send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key }),
      );
  }

  private async resolveObjectReference(body: Record<string, unknown>) {
    if (!isRecord(body.source) || typeof body.source.objectKey !== 'string')
      return body;
    const maximumBytes = MAX_UPLOAD_BYTES;
    const bucket =
      process.env.MYOTA_GEODATA_IMPORT_BUCKET ?? 'myota-geodata-imports';
    const requestedBucket =
      typeof body.source.bucket === 'string' ? body.source.bucket : bucket;
    const objectKey = body.source.objectKey;
    if (
      requestedBucket !== bucket ||
      !objectKey ||
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
      if (head.ContentLength! > maximumBytes)
        throw new BadRequestException(
          'source object exceeds the configured upload limit',
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
        if (size > maximumBytes)
          throw new BadRequestException(
            'source object exceeds the configured upload limit',
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
  const adapter = typeof body.adapter === 'string' ? body.adapter : '';
  if (!adapters.has(adapter))
    throw new BadRequestException('unsupported import adapter');
  const format =
    typeof body.format === 'string' ? body.format.toUpperCase() : 'GEOJSON';
  if (
    !['GEOJSON', 'WFS', 'ARCGIS_FEATURESERVER', 'KML', 'GPX'].includes(format)
  )
    throw new BadRequestException(
      'this import endpoint accepts GEOJSON, WFS GeoJSON, ARCGIS_FEATURESERVER JSON, KML, or GPX',
    );
  const source = body.source;
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw new BadRequestException('source must be an object');

  const entityTypes = normalizeEntityTypeCodes(
    firstPythonTruthy(body.entityTypes, body.entityTypeCodes),
    body.entityType,
  );
  if (!entityTypes.length)
    throw new BadRequestException(
      'entityTypes must contain at least one shared entity category code',
    );
  const disappearancePolicy =
    body.disappearancePolicy === undefined
      ? 'REVIEW_REQUIRED'
      : body.disappearancePolicy;
  const databaseDisappearancePolicy =
    typeof disappearancePolicy === 'string' &&
    ['UNCHANGED', 'STALE', 'RETIRED', 'REVIEW_REQUIRED'].includes(
      disappearancePolicy,
    )
      ? disappearancePolicy
      : 'REVIEW_REQUIRED';
  let document: Record<string, unknown>;
  if (Array.isArray(body.features)) {
    document = { type: 'FeatureCollection', features: body.features };
  } else if (typeof body.content === 'string') {
    if (format === 'KML' || format === 'GPX') {
      document = {
        type: 'FeatureCollection',
        features: parseXmlImport(format, body.content),
      };
    } else {
      try {
        const parsed: unknown = JSON.parse(body.content);
        if (Array.isArray(parsed))
          document = { type: 'FeatureCollection', features: parsed };
        else if (isRecord(parsed)) document = parsed;
        else throw new Error('expected an object or feature array');
      } catch {
        throw new BadRequestException(`${format} content must be valid JSON`);
      }
    }
  } else {
    throw new BadRequestException(`features or ${format} content is required`);
  }
  const sourceFormat = format;
  if (format === 'ARCGIS_FEATURESERVER')
    document = normalizeArcGisDocument(document);
  let features: unknown[];
  if (
    document.type === 'FeatureCollection' &&
    Array.isArray(document.features)
  ) {
    features = document.features;
  } else if (document.type === 'Feature') {
    features = [document];
    document = { type: 'FeatureCollection', features };
  } else if (isRecord(document.geometry)) {
    const feature: Record<string, unknown> = {
      type: 'Feature',
      geometry: document.geometry,
      properties: pythonTruthy(document.properties) ? document.properties : {},
    };
    if (document.id !== null && document.id !== undefined)
      feature.id = document.id;
    features = [feature];
    document = { type: 'FeatureCollection', features };
  } else if (
    [
      'Point',
      'LineString',
      'MultiLineString',
      'Polygon',
      'MultiPolygon',
    ].includes(String(document.type))
  ) {
    features = [{ type: 'Feature', geometry: document, properties: {} }];
    document = { type: 'FeatureCollection', features };
  } else {
    throw new BadRequestException(
      'GEOJSON must be a FeatureCollection, Feature, geometry, or feature array',
    );
  }
  if (
    Array.isArray(body.features) &&
    features.some((feature) => !isRecord(feature))
  )
    throw new BadRequestException('features must contain objects');
  if (features.length > MAX_IMPORT_FEATURES)
    throw new BadRequestException(
      `an import may contain at most ${MAX_IMPORT_FEATURES} features`,
    );
  return {
    adapter,
    source: source as Record<string, unknown>,
    entityTypes,
    filename:
      typeof body.filename === 'string' ? body.filename.slice(0, 255) : null,
    programmeSlug:
      typeof body.programmeSlug === 'string' ? body.programmeSlug : null,
    completeSnapshot: body.completeSnapshot === true,
    disappearancePolicy,
    databaseDisappearancePolicy,
    sourceFormat,
    document,
    features,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeArcGisDocument(
  document: Record<string, unknown>,
): Record<string, unknown> {
  if (isRecord(document.error))
    throw new BadRequestException('ArcGIS source returned an error document');
  if (!Array.isArray(document.features))
    throw new BadRequestException('ArcGIS response has no features array');
  const documentReference = isRecord(document.spatialReference)
    ? document.spatialReference
    : undefined;
  const features = document.features.map((raw) => {
    if (!isRecord(raw))
      throw new BadRequestException('ArcGIS feature is invalid');
    const geometry = isRecord(raw.geometry) ? raw.geometry : {};
    const geometryReference = isRecord(geometry.spatialReference)
      ? geometry.spatialReference
      : undefined;
    const reference = [documentReference, geometryReference].find(
      (candidate) =>
        candidate && (candidate.latestWkid != null || candidate.wkid != null),
    );
    const wkid = Number(
      [reference?.wkid, reference?.latestWkid].find(pythonTruthy) ?? 4326,
    );
    if (!Number.isInteger(wkid))
      throw new BadRequestException(`unsupported CRS EPSG:${String(wkid)}`);
    const properties = isRecord(raw.attributes) ? { ...raw.attributes } : {};
    let normalized: Record<string, unknown>;
    if (Array.isArray(geometry.rings))
      normalized = { type: 'Polygon', coordinates: geometry.rings };
    else if (Array.isArray(geometry.paths))
      normalized = {
        type: 'MultiLineString',
        coordinates: geometry.paths,
      };
    else if (typeof geometry.x === 'number' && typeof geometry.y === 'number')
      normalized = {
        type: 'Point',
        coordinates: [geometry.x, geometry.y],
      };
    else
      throw new BadRequestException('ArcGIS feature geometry is unsupported');

    if (wkid !== 4326) {
      const projectionWkid = [102100, 102113, 900913].includes(wkid)
        ? 3857
        : wkid;
      normalized.coordinates = reprojectCoordinates(
        normalized.coordinates,
        projectionWkid,
      );
    }
    properties.sourceFormat = 'ARCGIS_FEATURESERVER';
    properties.sourceRef ??=
      properties.objectId ?? properties.OBJECTID ?? properties.id;
    return { type: 'Feature', properties, geometry: normalized };
  });
  return { type: 'FeatureCollection', features };
}

function reprojectCoordinates(value: unknown, sourceWkid: number): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length >= 2 && value.slice(0, 2).every(Number.isFinite)) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    if (sourceWkid === 3857) {
      const longitude = (x / 20037508.34) * 180;
      const latitudeDegrees = (y / 20037508.34) * 180;
      const exponential = Math.exp((latitudeDegrees * Math.PI) / 180);
      if (!Number.isFinite(exponential))
        throw new BadRequestException('math range error');
      const latitude =
        (180 / Math.PI) * (2 * Math.atan(exponential) - Math.PI / 2);
      return [longitude, latitude];
    }
    try {
      const [longitude, latitude] = proj4(`EPSG:${sourceWkid}`, 'EPSG:4326', [
        x,
        y,
      ]);
      return [longitude, latitude, ...value.slice(2)];
    } catch (error) {
      throw new BadRequestException(`unsupported CRS EPSG:${sourceWkid}`, {
        cause: error,
      });
    }
  }
  return value.map((child) => reprojectCoordinates(child, sourceWkid));
}
