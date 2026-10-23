import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

test('rebuilds Activity statistics from the live Admin workflow', async ({
  page,
}) => {
  const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
  test.skip(!databaseUrl, 'requires the isolated Activity parity database');
  if (!databaseUrl) return;

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const fixtureId = randomUUID();
  const programmeSlug = `browser-statistics-${fixtureId}`;
  const activationId = randomUUID();
  const entityId = `statistics-entity-${fixtureId}`;
  let jobId: string | undefined;
  try {
    await pool.query(
      `INSERT INTO activity_activation
         (id,programme_slug,entity_id,entity_type,jurisdiction_code,
          operator_id,operator_callsign,started_at,status,qso_count,
          unique_callsign_count,unique_entity_count)
       VALUES ($1,$2,$3,'SOTA','CH','statistics-operator','HB9STATS',
          now(),'CLOSED',3,2,1)`,
      [activationId, programmeSlug, entityId],
    );

    await page.goto('/activity');
    await expect(page).toHaveURL(/\/login\?redirect=\/activity$/);
    await page
      .getByLabel('Email')
      .fill(
        process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ??
          'browser-e2e-admin@example.test',
      );
    await page
      .getByLabel('Password')
      .fill(
        process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ??
          'browser-e2e-password-7!Q',
      );
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/activity$/);
    await expect(
      page.getByRole('heading', { name: 'Statistics maintenance' }),
    ).toBeVisible();

    const [response] = await Promise.all([
      page.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).pathname === '/v1/statistics/rebuild-jobs' &&
          candidate.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Rebuild statistics' }).click(),
    ]);
    const responseText = await response.text();
    expect(response.status(), responseText).toBe(202);
    const request = response.request();
    expect(request.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
    expect(request.postDataJSON()).toEqual({ programmeSlug: null });
    const created = JSON.parse(responseText) as {
      jobId: string;
      kind: string;
      status: string;
    };
    jobId = created.jobId;
    expect(created).toMatchObject({
      jobId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      kind: 'STATISTICS_REBUILD',
    });

    await expect(page.locator('.activity-job')).toContainText(jobId);
    await expect
      .poll(
        async () => {
          const result = await pool.query<{ status: string }>(
            'SELECT status FROM activity_job WHERE id=$1::uuid',
            [jobId],
          );
          return result.rows[0]?.status;
        },
        { timeout: 30_000 },
      )
      .toBe('SUCCEEDED');

    await page.getByRole('button', { name: 'Refresh status' }).click();
    await expect(page.locator('.activity-job .status-pill')).toHaveText(
      'SUCCEEDED',
    );
    await expectResponsiveAccessible(
      page,
      'Live Admin Activity statistics rebuild completion',
    );
    const persisted = await pool.query<{
      kind: string;
      status: string;
      programme_slug: string | null;
      completed_at: Date | null;
    }>(
      `SELECT kind,status,payload->>'programmeSlug' AS programme_slug,
              completed_at
         FROM activity_job WHERE id=$1::uuid`,
      [jobId],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({
      kind: 'STATISTICS_REBUILD',
      status: 'SUCCEEDED',
      programme_slug: null,
    });
    expect(persisted.rows[0]?.completed_at).toBeInstanceOf(Date);
    const snapshots = await pool.query<{
      statistic_type: string;
      scope_key: string;
      metric_values: Record<string, number>;
    }>(
      `SELECT statistic_type,scope_key,metric_values
         FROM activity_statistic_snapshot
        WHERE programme_slug=$1 AND algorithm_version='activity-v2'`,
      [programmeSlug],
    );
    expect(snapshots.rows).toHaveLength(4);
    expect(snapshots.rows).toContainEqual(
      expect.objectContaining({
        statistic_type: 'ENTITY',
        scope_key: entityId,
        metric_values: { participants: 1, qsos: 3, activations: 1 },
      }),
    );
    expect(snapshots.rows).toContainEqual(
      expect.objectContaining({
        statistic_type: 'JURISDICTION',
        scope_key: 'CH',
        metric_values: { participants: 1, qsos: 3, activations: 1 },
      }),
    );
  } finally {
    if (jobId) {
      await pool.query(
        `DELETE FROM outbox_event
          WHERE producer='activity-service' AND aggregate_type='activity_job'
            AND aggregate_id=$1`,
        [jobId],
      );
      await pool.query('DELETE FROM activity_job WHERE id=$1::uuid', [jobId]);
    }
    await pool.query(
      'DELETE FROM activity_statistic_snapshot WHERE programme_slug=$1',
      [programmeSlug],
    );
    await pool.query('DELETE FROM activity_activation WHERE id=$1::uuid', [
      activationId,
    ]);
    await pool.end();
  }
});
