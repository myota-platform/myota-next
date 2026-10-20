import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import { parseJsonWithExactIntegers } from '@app/platform/json-exact.js';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { signAccessToken } from '@app/platform/access-token.js';
import { MAX_IMPORT_FEATURES } from '@app/platform/import-limits.js';
import { scheduledFeatureHashOverrides } from '../../geodata/src/geodata-request-fingerprint.js';

const DEFAULT_POLL_SECONDS = 60;
const SERVICE_SUBJECT = 'service:geodata-importer';
const IMPORT_SCOPES = ['geodata.import'];

type RefreshSchedule = {
  id: string;
  programmeSlug: string | null;
  adapter: string;
  source: Record<string, unknown>;
  entityTypes: string[];
  intervalSeconds: number | bigint;
  lastRunAt: string | null;
  disappearancePolicy: string;
  enabled: boolean;
  nextRunAt: string;
};

@Injectable()
export class GeodataImporterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GeodataImporterService.name);
  private stopping = false;
  private resolveStop!: () => void;
  private readonly stopSignal = new Promise<void>((resolve) => {
    this.resolveStop = resolve;
  });
  private readonly retryAfter = new Map<string, number>();
  private oneShotResult: unknown;

  async onModuleInit() {
    const importSpec = process.env.GEODATA_IMPORT_SPEC;
    if (importSpec !== undefined) {
      this.oneShotResult = await this.runImportSpec(
        JSON.parse(importSpec) as unknown,
      );
      return;
    }
    if (process.env.GEODATA_IMPORTER_ENABLED?.toLowerCase() !== 'true') {
      this.logger.log('Scheduled Geodata imports are disabled');
      return;
    }
    if (!process.env.MYOTA_AUTH_SIGNING_KEY)
      throw new Error('MYOTA_AUTH_SIGNING_KEY is required');
    const api = this.apiBase();
    this.assertApiUrl(api);
    this.logger.log('Scheduled Geodata imports are enabled');
    await this.poll();
    void this.runLoop();
  }

  getOneShotResult(): unknown {
    return this.oneShotResult;
  }

  async onModuleDestroy() {
    this.stopping = true;
    this.resolveStop();
  }

  private async runLoop() {
    const seconds = boundedInteger(
      process.env.GEODATA_IMPORTER_POLL_SECONDS,
      DEFAULT_POLL_SECONDS,
      15,
      3600,
    );
    while (!this.stopping) {
      await Promise.race([pause(seconds * 1000), this.stopSignal]);
      if (!this.stopping) await this.poll();
    }
  }

  private async poll() {
    try {
      for (const schedule of await this.listSchedules()) {
        const lastRunAt = schedule.lastRunAt
          ? Date.parse(schedule.lastRunAt)
          : Number.NaN;
        const dueAt = Number.isFinite(lastRunAt)
          ? typeof schedule.intervalSeconds === 'bigint'
            ? BigInt(lastRunAt) + schedule.intervalSeconds * 1000n
            : lastRunAt + schedule.intervalSeconds * 1000
          : Date.parse(schedule.nextRunAt);
        const isDue =
          typeof dueAt === 'bigint'
            ? dueAt <= BigInt(Date.now())
            : Number.isFinite(dueAt) && dueAt <= Date.now();
        if (
          this.stopping ||
          !schedule.enabled ||
          !isDue ||
          (this.retryAfter.get(schedule.id) ?? 0) > Date.now()
        )
          continue;
        try {
          await this.runSchedule(schedule);
          this.retryAfter.delete(schedule.id);
          this.logger.log(`Completed source fetch for schedule ${schedule.id}`);
        } catch (error) {
          this.retryAfter.set(schedule.id, Date.now() + 60_000);
          this.logger.error(
            `Scheduled source fetch failed for ${schedule.id}: ${safeError(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Schedule polling failed: ${safeError(error)}`);
    }
  }

  private async listSchedules(): Promise<RefreshSchedule[]> {
    const items: RefreshSchedule[] = [];
    for (let page = 1; ; page += 1) {
      const url = new URL(`${this.apiBase()}/v1/geodata/refresh-schedules`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('pageSize', '100');
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${this.accessToken()}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok)
        throw new Error(`schedule API returned HTTP ${response.status}`);
      const body: unknown = parseJsonWithExactIntegers(await response.text());
      if (
        !isRecord(body) ||
        !Array.isArray(body.items) ||
        body.page !== page ||
        body.pageSize !== 100 ||
        !Number.isInteger(body.total) ||
        (body.nextPage !== null && body.nextPage !== page + 1)
      )
        throw new Error('schedule API returned an invalid response');
      items.push(...(body.items as RefreshSchedule[]));
      if (body.nextPage === null) return items;
    }
  }

  private async runSchedule(schedule: RefreshSchedule) {
    const sourceUrl = schedule.source.url;
    if (typeof sourceUrl !== 'string')
      throw new Error('schedule source.url must be a string');
    const { document, rawJson } = await this.fetchSource(sourceUrl);
    const formatValue = schedule.source.format;
    const format =
      typeof formatValue === 'string' ? formatValue.toUpperCase() : 'GEOJSON';
    const features = featuresFromDocument(document, format);
    if (features.length > MAX_IMPORT_FEATURES)
      throw new Error(
        `source exceeds the ${MAX_IMPORT_FEATURES} feature limit`,
      );
    const sourceFeatureHashOverrides = scheduledFeatureHashOverrides(
      rawJson,
      format,
    );

    const base = this.apiBase();
    const url = `${base}/v1/geodata/refresh-schedules/${encodeURIComponent(schedule.id)}/run`;
    const idempotencyKey = `geodata-schedule:${schedule.id}:${schedule.nextRunAt}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.accessToken()}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: stringifyJsonWithBigInts({
        features,
        ...(sourceFeatureHashOverrides ? { sourceFeatureHashOverrides } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new Error(`schedule run API returned HTTP ${response.status}`);
  }

  private async runImportSpec(value: unknown): Promise<unknown> {
    if (!isRecord(value) || !isRecord(value.source))
      throw new Error('GEODATA_IMPORT_SPEC must contain a source object');
    const spec = value;
    const source = spec.source;
    if (typeof source.url !== 'string')
      throw new Error('GEODATA_IMPORT_SPEC source.url must be a string');
    const { document, rawJson } = await this.fetchSource(source.url);
    const format =
      typeof source.format === 'string' && source.format
        ? source.format.toUpperCase()
        : 'GEOJSON';
    const features = featuresFromDocument(document, format);
    if (features.length > MAX_IMPORT_FEATURES)
      throw new Error(
        `source exceeds the ${MAX_IMPORT_FEATURES} feature limit`,
      );

    const rawApiUrl = Object.hasOwn(spec, 'geodataUrl')
      ? spec.geodataUrl
      : this.apiBase();
    if (typeof rawApiUrl !== 'string')
      throw new Error('GEODATA_IMPORT_SPEC geodataUrl must be a string');
    this.assertApiUrl(rawApiUrl);
    const apiUrl = `${rawApiUrl.replace(/\/$/, '')}/v1/geodata/imports`;
    const requestedKey =
      spec.idempotencyKey !== undefined
        ? spec.idempotencyKey
        : source.sourceKey !== undefined
          ? source.sourceKey
          : source.url;
    if (typeof requestedKey !== 'string')
      throw new Error('GEODATA_IMPORT_SPEC idempotency key must be a string');
    const token = Object.hasOwn(spec, 'accessToken')
      ? spec.accessToken
      : this.accessToken();
    if (typeof token !== 'string')
      throw new Error('GEODATA_IMPORT_SPEC accessToken must be a string');
    const disappearancePolicy = Object.hasOwn(spec, 'disappearancePolicy')
      ? spec.disappearancePolicy
      : 'REVIEW_REQUIRED';
    const sourceFeatureHashOverrides = scheduledFeatureHashOverrides(
      rawJson,
      format,
    );
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': requestedKey,
      },
      body: stringifyJsonWithBigInts({
        programmeSlug: spec.programmeSlug,
        adapter: spec.adapter,
        source,
        features,
        completeSnapshot: true,
        disappearancePolicy,
        ...(sourceFeatureHashOverrides ? { sourceFeatureHashOverrides } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`import API returned HTTP ${response.status}`);
    return parseJsonWithExactIntegers(await response.text());
  }

  private async fetchSource(rawUrl: string): Promise<{
    document: unknown;
    rawJson: string;
  }> {
    const url = new URL(rawUrl);
    const allowedHosts = (process.env.GEODATA_SOURCE_ALLOWLIST ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !allowedHosts.some(
        (host) =>
          url.hostname.toLowerCase() === host ||
          url.hostname.toLowerCase().endsWith(`.${host}`),
      )
    )
      throw new Error('source URL must use HTTPS and an allowlisted host');

    const response = await fetch(url, {
      headers: {
        accept: 'application/geo+json, application/json',
        'user-agent': 'MyOTA-geodata-importer/1.0',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error('source redirects are not supported');
    if (!response.ok)
      throw new Error(`source returned HTTP ${response.status}`);
    if (!response.body) throw new Error('source returned an empty response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      return { document: JSON.parse(text) as unknown, rawJson: text };
    } catch {
      throw new Error('source did not return valid JSON');
    }
  }

  private apiBase() {
    return (process.env.MYOTA_GEODATA_URL ?? 'http://geodata:8003').replace(
      /\/$/,
      '',
    );
  }

  private assertApiUrl(rawUrl: string) {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('MYOTA_GEODATA_URL must use HTTP or HTTPS');
  }

  private accessToken() {
    return signAccessToken(SERVICE_SUBJECT, IMPORT_SCOPES, [], 300);
  }
}

function featuresFromDocument(document: unknown, format: string) {
  if (
    isRecord(document) &&
    document.type === 'FeatureCollection' &&
    Array.isArray(document.features) &&
    document.features.every(isRecord)
  )
    return document.features;
  if (format === 'ARCGIS_FEATURESERVER' && isRecord(document)) {
    if (isRecord(document.error))
      throw new Error('ArcGIS source returned an error document');
    if (!Array.isArray(document.features))
      throw new Error('ArcGIS response has no features array');
    return document.features.map((item) => {
      if (!isRecord(item)) throw new Error('ArcGIS feature is invalid');
      const geometry = isRecord(item.geometry) ? item.geometry : {};
      const properties = isRecord(item.attributes) ? item.attributes : {};
      let geoJsonGeometry: Record<string, unknown>;
      if (Array.isArray(geometry.rings))
        geoJsonGeometry = { type: 'Polygon', coordinates: geometry.rings };
      else if (Array.isArray(geometry.paths))
        geoJsonGeometry = {
          type: 'MultiLineString',
          coordinates: geometry.paths,
        };
      else if (typeof geometry.x === 'number' && typeof geometry.y === 'number')
        geoJsonGeometry = {
          type: 'Point',
          coordinates: [geometry.x, geometry.y],
        };
      else throw new Error('ArcGIS feature geometry is unsupported');
      return { type: 'Feature', properties, geometry: geoJsonGeometry };
    });
  }
  throw new Error(
    'source response must be a GeoJSON FeatureCollection or ArcGIS FeatureServer JSON',
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function pause(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
