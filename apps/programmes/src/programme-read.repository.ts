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
           SELECT content.value
             FROM public.service_state AS snapshot
             CROSS JOIN LATERAL jsonb_each(
               CASE WHEN jsonb_typeof(snapshot.state #> '{data,content}') = 'object'
                 THEN snapshot.state #> '{data,content}'
                 ELSE '{}'::jsonb
               END
             ) AS content(key, value)
            WHERE snapshot.service = 'programmes'
              AND content.value->>'programmeSlug' = $1
              AND ($2::text IS NULL OR content.value->>'locale' = $2)
              AND ($3::text IS NULL OR content.value->>'status' = $3)
         ), page AS (
           SELECT value FROM filtered
            ORDER BY value->>'key' COLLATE "C", value->>'locale' COLLATE "C"
            LIMIT $4 OFFSET $5
         )
         SELECT COALESCE(
                  (SELECT jsonb_agg(page.value ORDER BY
                    page.value->>'key' COLLATE "C",
                    page.value->>'locale' COLLATE "C") FROM page),
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
           SELECT draft.value
             FROM public.service_state AS snapshot
             CROSS JOIN LATERAL jsonb_each(
               CASE WHEN jsonb_typeof(snapshot.state #> '{data,policyDrafts}') = 'object'
                 THEN snapshot.state #> '{data,policyDrafts}'
                 ELSE '{}'::jsonb
               END
             ) AS draft(key, value)
            WHERE snapshot.service = 'programmes'
              AND draft.value->>'programmeSlug' = $1
              AND ($2::text IS NULL OR draft.value->>'type' = $2)
         ), page AS (
           SELECT value FROM filtered
            ORDER BY value->>'updatedAt' COLLATE "C" DESC
            LIMIT $3 OFFSET $4
         )
         SELECT COALESCE(
                  (SELECT jsonb_agg(page.value ORDER BY
                    page.value->>'updatedAt' COLLATE "C" DESC) FROM page),
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
           SELECT state #> ARRAY['items', $1] AS value,
                  CASE
                    WHEN jsonb_typeof(
                      (state #> ARRAY['items', $1])->'locales'
                    ) = 'array'
                    THEN jsonb_array_length(
                      (state #> ARRAY['items', $1])->'locales'
                    ) > 0
                    ELSE false
                  END AS has_configured_locales
             FROM public.service_state
            WHERE service = 'programmes'
         ), content AS MATERIALIZED (
           SELECT entry.value->>'key' AS content_key,
                  entry.value->>'locale' AS locale,
                  entry.value->>'status' AS status
             FROM public.service_state AS snapshot
             CROSS JOIN LATERAL jsonb_each(
               CASE WHEN jsonb_typeof(snapshot.state #> '{data,content}') = 'object'
                 THEN snapshot.state #> '{data,content}'
                 ELSE '{}'::jsonb
               END
             ) AS entry(id, value)
            WHERE snapshot.service = 'programmes'
              AND entry.value->>'programmeSlug' = $1
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
                      'total', (SELECT count(*)::int FROM content_keys),
                      'coveragePercent', CASE
                        WHEN (SELECT count(*) FROM content_keys) = 0 THEN 0
                        ELSE floor(
                          coverage.published * 100.0 /
                          (SELECT count(*) FROM content_keys) + 0.5
                        )::int
                      END,
                      'missingKeys', coverage.missing_keys
                    ) ORDER BY coverage.locale_order
                  ) FROM coverage),
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
