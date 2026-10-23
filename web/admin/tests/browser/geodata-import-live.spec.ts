import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

test('preprocesses, reviews, and promotes a pasted GeoJSON import through live services', async ({
  page,
}) => {
  test.skip(
    process.env.MYOTA_BROWSER_GEODATA_WORKERS !== '1',
    'requires the CI Geodata workers and JetStream topology',
  );
  const databaseUrl = process.env.GEO_DATABASE_URL;
  const coreDatabaseUrl = process.env.CORE_DATABASE_URL;
  test.skip(
    !databaseUrl || !coreDatabaseUrl,
    'requires the isolated Core and Geodata parity databases',
  );
  if (!databaseUrl || !coreDatabaseUrl) return;

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const fixture = await pool.connect();
  const corePool = new Pool({ connectionString: coreDatabaseUrl, max: 1 });
  let importRunId: string | undefined;
  const suffix = randomUUID();
  const entityTypeCode = `LIVE_IMPORT_${suffix.replaceAll('-', '').slice(0, 16).toUpperCase()}`;
  try {
    const rejectedName = `Live import reject ${suffix}`;
    const promotedName = `Live import promote ${suffix}`;
    const secondPromotedName = `Live import promote second ${suffix}`;

    await page.goto('/master-data');
    await expect(page).toHaveURL(/\/login\?redirect=\/master-data$/);
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
    await expect(page).toHaveURL(/\/master-data$/);
    await page.getByRole('button', { name: 'New category' }).click();
    await page.getByLabel('Category code').fill(entityTypeCode);
    await page
      .getByLabel('Display name')
      .fill(`Live import category ${suffix.slice(0, 8)}`);
    await page.getByRole('checkbox', { name: 'Point', exact: true }).check();
    await page
      .getByLabel('Description')
      .fill('Temporary category for the live import workflow.');
    await page.getByRole('button', { name: 'Save category' }).click();
    await expect(page.getByText('Category saved.')).toBeVisible();

    await page.goto('/geodata-imports');
    await expect(page).toHaveURL(/\/geodata-imports$/);

    await page.getByLabel('Feature category').selectOption(entityTypeCode);
    await page.getByLabel('Source label').fill(`Browser source ${suffix}`);
    await page.getByLabel('Licence').fill('CC BY 4.0');
    await page.getByLabel('Attribution').fill('Browser parity fixture');
    await page.getByLabel('Source filename').fill(`browser-${suffix}.geojson`);
    await page.getByLabel('Paste source document').fill(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { name: rejectedName },
            geometry: { type: 'Point', coordinates: [6.456789, 45.6789] },
          },
          {
            type: 'Feature',
            properties: { name: promotedName },
            geometry: { type: 'Point', coordinates: [6.567891, 45.7891] },
          },
          {
            type: 'Feature',
            properties: { name: secondPromotedName },
            geometry: { type: 'Point', coordinates: [6.678912, 45.8912] },
          },
        ],
      }),
    );
    const [importResponse] = await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === '/v1/geodata/imports' &&
          response.request().method() === 'POST'
        );
      }),
      page.getByRole('button', { name: 'Queue preprocessing' }).click(),
    ]);
    expect(importResponse.status()).toBe(202);
    importRunId = (await importResponse.json()).id as string;
    expect(importRunId).toMatch(/^[0-9a-f-]{36}$/i);

    await expect(
      page.getByText('Dataset queued for preprocessing.'),
    ).toBeVisible();
    await expect(page.getByText('Review pre-processed records')).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      page.getByRole('button', { name: rejectedName }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: promotedName }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: secondPromotedName }),
    ).toBeVisible();
    const rejectedCandidate = await fixture.query<{ id: string }>(
      `SELECT id::text AS id FROM geodata_import_candidate
        WHERE import_run_id=$1::uuid AND name=$2`,
      [importRunId, rejectedName],
    );
    expect(rejectedCandidate.rows).toHaveLength(1);
    const rejectedCandidateId = rejectedCandidate.rows[0]!.id;

    await page.getByRole('button', { name: rejectedName }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('PENDING');
    await dialog.getByRole('button', { name: 'Reject entity' }).click();
    await expect(dialog.getByRole('status')).toContainText(
      `Next item: ${promotedName}.`,
    );
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByLabel('Select all pending records').check();
    await expect(
      page.getByText('2 pending records selected across all pages.'),
    ).toBeVisible();
    const [promotionResponse] = await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `/v1/geodata/imports/${importRunId}/process` &&
          response.request().method() === 'POST'
        );
      }),
      page
        .getByRole('button', { name: 'Promote selected to candidate' })
        .click(),
    ]);
    expect(promotionResponse.status()).toBe(200);
    const promotionResult = await promotionResponse.json();
    expect(promotionResult).toMatchObject({
      importRunId,
      targetStatus: 'CANDIDATE',
      status: 'COMPLETED',
    });
    expect(promotionResult.candidateIds).toHaveLength(2);
    expect(promotionResult.created).toHaveLength(2);
    expect(promotionResult.updated).toEqual([]);
    await expect(
      page.getByText('2 records were promoted to candidate successfully.'),
    ).toBeVisible();
    await expectResponsiveAccessible(page, 'Live Admin Geodata import review');

    const persisted = await fixture.query(
      `SELECT r.status AS import_status,
              r.stats->>'preprocessed' AS preprocessed_count,
              (SELECT count(*) FROM geodata_import_candidate rejected
                WHERE rejected.import_run_id=r.id AND rejected.id=$3::uuid)
                AS rejected_candidate_count,
              EXISTS (SELECT 1 FROM outbox_event rejected_event
                WHERE rejected_event.aggregate_type='import_run'
                  AND rejected_event.aggregate_id=r.id::text
                  AND rejected_event.event_type='geodata.import.candidates.rejected.v1'
                  AND rejected_event.payload->>'reviewerId' IS NOT NULL
                  AND rejected_event.payload->'candidateIds' ? $3::text)
                AS rejection_event_persisted,
              promoted.name AS promoted_name,
              promoted.validation_status AS promoted_status,
              promoted.target_status,
              promoted.processed_entity_id::text AS processed_entity_id,
              promoted.processing_queue_id IS NOT NULL AS promotion_queue_assigned,
              e.lifecycle_status AS entity_status,
              e.name AS entity_name,
              e.entity_type_code AS entity_type_code,
              EXISTS (SELECT 1 FROM outbox_event promoted_event
                WHERE promoted_event.aggregate_type='entity'
                  AND promoted_event.aggregate_id=e.id::text
                  AND promoted_event.producer='geodata-service'
                  AND promoted_event.event_type='geodata.entity.candidate.created.v1')
                AS promotion_event_persisted
         FROM import_run r
         LEFT JOIN geodata_import_candidate promoted
           ON promoted.import_run_id=r.id AND promoted.name=ANY($2::text[])
         LEFT JOIN geodata_entity e ON e.id=promoted.processed_entity_id
         WHERE r.id=$1::uuid
         ORDER BY promoted.ordinal`,
      [importRunId, [promotedName, secondPromotedName], rejectedCandidateId],
    );
    expect(persisted.rows).toHaveLength(2);
    expect(persisted.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          import_status: 'COMPLETED',
          preprocessed_count: '3',
          rejected_candidate_count: '0',
          rejection_event_persisted: true,
          promoted_name: promotedName,
          promoted_status: 'PROCESSED',
          target_status: 'CANDIDATE',
          promotion_queue_assigned: false,
          entity_status: 'CANDIDATE',
          entity_name: promotedName,
          entity_type_code: entityTypeCode,
          promotion_event_persisted: true,
        }),
        expect.objectContaining({
          import_status: 'COMPLETED',
          preprocessed_count: '3',
          rejected_candidate_count: '0',
          rejection_event_persisted: true,
          promoted_name: secondPromotedName,
          promoted_status: 'PROCESSED',
          target_status: 'CANDIDATE',
          promotion_queue_assigned: false,
          entity_status: 'CANDIDATE',
          entity_name: secondPromotedName,
          entity_type_code: entityTypeCode,
          promotion_event_persisted: true,
        }),
      ]),
    );
    for (const row of persisted.rows)
      expect(row.processed_entity_id).toMatch(/^[0-9a-f-]{36}$/i);
  } finally {
    await fixture.query('ROLLBACK').catch(() => undefined);
    try {
      if (importRunId) {
        await fixture.query('BEGIN');
        await fixture.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        const processedEntities = await fixture.query<{ id: string }>(
          `SELECT processed_entity_id::text AS id FROM geodata_import_candidate
            WHERE import_run_id=$1::uuid AND processed_entity_id IS NOT NULL`,
          [importRunId],
        );
        const entityIds = processedEntities.rows.map((row) => row.id);
        if (entityIds.length) {
          await fixture.query(
            `DELETE FROM outbox_event WHERE aggregate_type='entity'
              AND aggregate_id=ANY($1::text[])`,
            [entityIds],
          );
          await fixture.query(
            'DELETE FROM source_reference WHERE entity_id=ANY($1::uuid[])',
            [entityIds],
          );
          await fixture.query(
            'DELETE FROM geodata_entity WHERE id=ANY($1::uuid[])',
            [entityIds],
          );
        }
        await fixture.query(
          `DELETE FROM outbox_event
            WHERE (aggregate_type='import_run' AND aggregate_id=$1)
               OR (aggregate_type='import_processing_queue' AND aggregate_id IN
                 (SELECT id::text FROM geodata_import_processing_queue WHERE import_run_id=$1::uuid))`,
          [importRunId],
        );
        await fixture.query(
          'DELETE FROM source_snapshot_manifest WHERE import_run_id=$1::uuid',
          [importRunId],
        );
        await fixture.query(
          'DELETE FROM geodata_import_candidate_stage WHERE import_run_id=$1::uuid',
          [importRunId],
        );
        await fixture.query('DELETE FROM import_run WHERE id=$1::uuid', [
          importRunId,
        ]);
        await fixture.query(
          `DELETE FROM idempotency_record
            WHERE service='geodata-service' AND response->>'id'=$1`,
          [importRunId],
        );
        await fixture.query('COMMIT');
      }
    } finally {
      fixture.release();
      await pool.end();
      await corePool.query('DELETE FROM programme_entity_type WHERE code=$1', [
        entityTypeCode,
      ]);
      await corePool.end();
    }
  }
});
