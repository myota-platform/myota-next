import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';

test('records a live conflation decision through Admin and Geodata', async ({
  page,
}) => {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  test.skip(!databaseUrl, 'requires the isolated Geodata parity database');
  if (!databaseUrl) return;

  const entityLeftId = randomUUID();
  const entityRightId = randomUUID();
  const candidateId = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
  const candidatePathId = candidateId.replaceAll('-', '');
  const leftName = `Live conflation left ${entityLeftId}`;
  const rightName = `Live conflation right ${entityRightId}`;
  const note = `Distinct locations ${candidateId}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const fixture = await pool.connect();
  let idempotencyKey: string | undefined;

  try {
    await fixture.query('BEGIN');
    await fixture.query(
      "SELECT set_config('myota.geodata_writer','row-v1',true)",
    );
    await fixture.query(
      `INSERT INTO geodata_entity
         (id,name,lifecycle_status,geom,programme_slug,entity_type_code)
       VALUES
         ($1,$2,'APPROVED',ST_SetSRID(ST_MakePoint(7.2,46.1),4326),'live-conflation','SOTA'),
         ($3,$4,'APPROVED',ST_SetSRID(ST_MakePoint(7.2001,46.1001),4326),'live-conflation','SOTA')`,
      [entityLeftId, leftName, entityRightId, rightName],
    );
    await fixture.query(
      `INSERT INTO conflation_candidate
         (id,left_entity_id,right_entity_id,similarity,reason,programme_slug)
       VALUES ($1,$2,$3,0.98,'{"distanceMeters":14}'::jsonb,'live-conflation')`,
      [candidateId, entityLeftId, entityRightId],
    );
    await fixture.query('COMMIT');

    await page.goto('/conflation');
    await expect(page).toHaveURL(/\/login\?redirect=\/conflation$/);
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
    await expect(page).toHaveURL(/\/conflation$/);

    const card = page.locator('.conflation-card').filter({ hasText: leftName });
    await expect(card).toContainText(rightName);
    await card.getByLabel('Decision').selectOption('KEPT_SEPARATE');
    await card
      .getByLabel('Surviving entity (optional)')
      .selectOption(entityRightId);
    await card.getByLabel('Review note').fill(note);

    const decisionResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === `/v1/geodata/conflation/${candidatePathId}/resolve` &&
        response.request().method() === 'POST'
      );
    });
    await card.getByRole('button', { name: 'Record decision' }).click();
    const response = await decisionResponse;
    expect(response.status(), await response.text()).toBe(200);
    const request = response.request();
    const body = request.postDataJSON() as {
      decision: string;
      reviewerId: string;
      survivorEntityId: string;
      note: string;
    };
    expect(body).toMatchObject({
      decision: 'KEPT_SEPARATE',
      survivorEntityId: entityRightId,
      note,
    });
    expect(body.reviewerId).toMatch(/^[0-9a-f-]{36}$/i);
    idempotencyKey = request.headers()['idempotency-key'];
    expect(idempotencyKey).toBeTruthy();

    await expect(page.locator('.success-text[role="status"]')).toContainText(
      `Resolution recorded for ${candidatePathId}.`,
    );
    await expect(card).toHaveCount(0);

    const persisted = await fixture.query<{
      resolution: string;
      survivor_entity_id: string;
      resolved_by: string;
      decision: string;
      reviewer_id: string;
      note: string;
      outbox_count: number;
      idempotency_count: number;
    }>(
      `SELECT c.resolution,c.survivor_entity_id::text,c.resolved_by::text,
              c.resolution_history->-1->>'decision' AS decision,
              c.resolution_history->-1->>'reviewerId' AS reviewer_id,
              c.resolution_history->-1->>'note' AS note,
              (SELECT count(*)::int FROM outbox_event o
                WHERE o.aggregate_type='conflation_candidate'
                  AND o.aggregate_id=$2
                  AND o.event_type='geodata.conflation.resolved.v1'
                  AND o.payload->>'reviewerId'=$3
                  AND o.payload->>'note'=$4) AS outbox_count,
              (SELECT count(*)::int FROM idempotency_record i
                WHERE i.service='geodata-conflation' AND i.key=$5) AS idempotency_count
         FROM conflation_candidate c WHERE c.id=$1::uuid`,
      [candidateId, candidatePathId, body.reviewerId, note, idempotencyKey],
    );
    expect(persisted.rows).toEqual([
      {
        resolution: 'KEPT_SEPARATE',
        survivor_entity_id: entityRightId,
        resolved_by: body.reviewerId,
        decision: 'KEPT_SEPARATE',
        reviewer_id: body.reviewerId,
        note,
        outbox_count: 1,
        idempotency_count: 1,
      },
    ]);
  } finally {
    try {
      await fixture.query('ROLLBACK').catch(() => undefined);
      await fixture.query('BEGIN');
      await fixture.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await fixture.query(
        `DELETE FROM outbox_event
          WHERE aggregate_type='conflation_candidate' AND aggregate_id=$1`,
        [candidatePathId],
      );
      if (idempotencyKey)
        await fixture.query(
          "DELETE FROM idempotency_record WHERE service='geodata-conflation' AND key=$1",
          [idempotencyKey],
        );
      await fixture.query(
        'DELETE FROM conflation_candidate WHERE id=$1::uuid',
        [candidateId],
      );
      await fixture.query(
        'DELETE FROM geodata_entity WHERE id=ANY($1::uuid[])',
        [[entityLeftId, entityRightId]],
      );
      await fixture.query('COMMIT');
    } finally {
      await fixture.query('ROLLBACK').catch(() => undefined);
      fixture.release();
      await pool.end();
    }
  }
});
