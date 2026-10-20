import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';

export interface SnapshotPage {
  items: Record<string, unknown>[];
  total: number;
}

export interface PublishedContentPage {
  programmeFound: boolean;
  items: Record<string, unknown>[];
}

export interface ContentCoverage {
  programmeFound: boolean;
  totalKeys: number;
  locales: {
    locale: string;
    published: number;
    total: number;
    coveragePercent: number;
    missingKeys: string[];
  }[];
}

@Injectable()
export class ProgrammeReadRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async listContentPage(
    programmeSlug: string,
    locale: string | undefined,
    status: string | undefined,
    pageSize: number,
    offset: number,
  ): Promise<SnapshotPage> {
    const client = await this.connect();
    try {
      const result = await client.query<SnapshotPage>(
        `WITH filtered AS MATERIALIZED (
           SELECT content.payload AS value,
                  content.content_key,
                  content.locale,
                  content.content_order
             FROM public.programme_content AS content
            WHERE content.programme_slug = $1
              AND ($2::text IS NULL OR content.locale = $2)
              AND ($3::text IS NULL OR content.status = $3)
         ), page AS (
           SELECT value, content_key, locale, content_order FROM filtered
            ORDER BY content_key COLLATE "C",
                     locale COLLATE "C",
                     content_order
            LIMIT $4 OFFSET $5
         )
         SELECT COALESCE(
                  (SELECT jsonb_agg(page.value ORDER BY
                    page.content_key COLLATE "C",
                    page.locale COLLATE "C",
                    page.content_order) FROM page),
                  '[]'::jsonb
                ) AS items,
                (SELECT count(*)::int FROM filtered) AS total`,
        [programmeSlug, locale ?? null, status ?? null, pageSize, offset],
      );
      const row = result.rows[0];
      return { items: row?.items ?? [], total: row?.total ?? 0 };
    } finally {
      client.release();
    }
  }

  async listPublishedContent(
    programmeSlug: string,
    locale: string | undefined,
  ): Promise<PublishedContentPage> {
    const client = await this.connect();
    try {
      const result = await client.query<PublishedContentPage>(
        `WITH eligible AS MATERIALIZED (
           SELECT content.id,content.content_key,content.locale,content.payload,
                  row_number() OVER (
                    PARTITION BY content.content_key,content.locale
                    ORDER BY (content.payload->>'effectiveFrom')::timestamptz DESC,
                             (content.payload->>'publishedAt')::timestamptz DESC,
                             content.id COLLATE "C" DESC
                  ) AS version_rank
             FROM public.programme_content AS content
            WHERE content.programme_slug=$1
              AND content.status='PUBLISHED'
              AND (content.payload->>'effectiveFrom')::timestamptz <= now()
              AND ($2::text IS NULL OR content.locale=$2)
         ), visible AS (
           SELECT content_key,locale,payload FROM eligible WHERE version_rank=1
         )
         SELECT EXISTS(
                  SELECT 1 FROM public.programme_record WHERE slug=$1
                ) AS "programmeFound",
                COALESCE(
                  (SELECT jsonb_agg(
                    jsonb_build_object(
                      'key',payload->>'key',
                      'locale',locale,
                      'value',payload->'value',
                      'fallbackLocale',payload->'fallbackLocale',
                      'effectiveFrom',payload->'effectiveFrom',
                      'publishedAt',payload->'publishedAt'
                    ) ORDER BY content_key COLLATE "C",locale COLLATE "C"
                  ) FROM visible),
                  '[]'::jsonb
                ) AS items`,
        [programmeSlug, locale ?? null],
      );
      return result.rows[0] ?? { programmeFound: false, items: [] };
    } finally {
      client.release();
    }
  }

  async listPolicyDraftPage(
    programmeSlug: string,
    type: string | undefined,
    pageSize: number,
    offset: number,
  ): Promise<SnapshotPage> {
    const client = await this.connect();
    try {
      const result = await client.query<SnapshotPage>(
        `WITH filtered AS MATERIALIZED (
           SELECT draft.payload AS value, draft.updated_at, draft.id
             FROM public.programme_policy_draft AS draft
            WHERE draft.programme_slug = $1
              AND ($2::text IS NULL OR draft.draft_type = $2)
         ), page AS (
           SELECT value, updated_at, id FROM filtered
            ORDER BY updated_at COLLATE "C" DESC, id COLLATE "C"
            LIMIT $3 OFFSET $4
         )
         SELECT COALESCE(
                  (SELECT jsonb_agg(page.value ORDER BY
                    page.updated_at COLLATE "C" DESC, page.id COLLATE "C") FROM page),
                  '[]'::jsonb
                ) AS items,
                (SELECT count(*)::int FROM filtered) AS total`,
        [programmeSlug, type ?? null, pageSize, offset],
      );
      const row = result.rows[0];
      return { items: row?.items ?? [], total: row?.total ?? 0 };
    } finally {
      client.release();
    }
  }

  async getContentCoverage(slug: string): Promise<ContentCoverage> {
    const client = await this.connect();
    try {
      const result = await client.query<ContentCoverage>(
        `WITH programme AS (
           SELECT payload AS value,
                  CASE
                    WHEN jsonb_typeof(payload->'locales') = 'array'
                    THEN jsonb_array_length(
                      payload->'locales'
                    ) > 0
                    ELSE false
                  END AS has_configured_locales
             FROM public.programme_record
            WHERE slug = $1
         ), content AS MATERIALIZED (
           SELECT content_key, locale, status
             FROM public.programme_content
            WHERE programme_slug = $1
         ), content_keys AS (
           SELECT DISTINCT content_key
             FROM content
            WHERE content_key IS NOT NULL
         ), configured_locales AS (
           SELECT element.value #>> '{}' AS locale,
                  element.ordinality::int AS locale_order
             FROM programme
             CROSS JOIN LATERAL jsonb_array_elements(
               CASE WHEN programme.has_configured_locales
                 THEN programme.value->'locales'
                 ELSE '[]'::jsonb
               END
             ) WITH ORDINALITY AS element(value, ordinality)
            WHERE jsonb_typeof(element.value) = 'string'
         ), locale_source AS (
           SELECT locale, locale_order FROM configured_locales
           UNION ALL
           SELECT distinct_locale.locale,
                  row_number() OVER (ORDER BY distinct_locale.locale COLLATE "C")::int
             FROM (SELECT DISTINCT locale FROM content WHERE locale IS NOT NULL)
                  AS distinct_locale
             CROSS JOIN programme
            WHERE NOT programme.has_configured_locales
         ), effective_locales AS (
           SELECT locale, locale_order FROM locale_source
           UNION ALL
           SELECT 'en', 1 WHERE NOT EXISTS (SELECT 1 FROM locale_source)
         ), coverage AS (
           SELECT effective.locale,
                  effective.locale_order,
                  (SELECT count(DISTINCT published.content_key)::int
                     FROM content AS published
                    WHERE published.locale = effective.locale
                      AND published.status = 'PUBLISHED') AS published,
                  (SELECT COALESCE(
                            jsonb_agg(content_keys.content_key ORDER BY content_keys.content_key COLLATE "C"),
                            '[]'::jsonb
                          )
                     FROM content_keys
                    WHERE NOT EXISTS (
                      SELECT 1 FROM content AS published
                       WHERE published.locale = effective.locale
                         AND published.status = 'PUBLISHED'
                         AND published.content_key = content_keys.content_key
                    )) AS missing_keys
             FROM effective_locales AS effective
         ), coverage_values AS (
           SELECT coverage.*,
                  (SELECT count(*)::int FROM content_keys) AS total,
                  coverage.published * 100.0 /
                    NULLIF((SELECT count(*) FROM content_keys), 0) AS percentage
             FROM coverage
         )
         SELECT EXISTS(
                  SELECT 1 FROM programme
                   WHERE jsonb_typeof(programme.value) = 'object'
                ) AS "programmeFound",
                (SELECT count(*)::int FROM content_keys) AS "totalKeys",
                COALESCE(
                  (SELECT jsonb_agg(
                    jsonb_build_object(
                      'locale', coverage.locale,
                      'published', coverage.published,
                      'total', coverage.total,
                      'coveragePercent', CASE
                        WHEN coverage.total = 0 THEN 0
                        WHEN coverage.percentage - floor(coverage.percentage) = 0.5
                          THEN (floor(coverage.percentage) +
                                mod(floor(coverage.percentage), 2))::int
                        ELSE round(coverage.percentage)::int
                      END,
                      'missingKeys', coverage.missing_keys
                    ) ORDER BY coverage.locale_order
                  ) FROM coverage_values AS coverage),
                  '[]'::jsonb
                ) AS locales`,
        [slug],
      );
      return (
        result.rows[0] ?? { programmeFound: false, totalKeys: 0, locales: [] }
      );
    } finally {
      client.release();
    }
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool) {
      throw new ServiceUnavailableException(
        'Programme database is not configured',
      );
    }
    try {
      return await this.pool.connect();
    } catch {
      throw new ServiceUnavailableException(
        'Programme database is unavailable',
      );
    }
  }
}
