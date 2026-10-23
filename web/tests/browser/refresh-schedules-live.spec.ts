import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';

test('creates and runs a complete refresh snapshot through live services', async ({
  request,
}) => {
  test.skip(
    process.env.MYOTA_BROWSER_GEODATA_WORKERS !== '1',
    'requires the CI Geodata workers and JetStream topology',
  );
  const databaseUrl = process.env.GEO_DATABASE_URL;
  test.skip(!databaseUrl, 'requires the isolated Geodata parity database');
  if (!databaseUrl) return;

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const fixture = await pool.connect();
  const fixtureId = randomUUID();
  const programmeSlug = `browser-schedule-${fixtureId}`;
  const sourceKey = `browser-schedule-${fixtureId}`;
  let scheduleId: string | undefined;
  let importRunId: string | undefined;

  try {
    const email =
      process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ??
      'browser-e2e-admin@example.test';
    const password =
      process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
    const login = await request.post(
      'http://127.0.0.1:8080/v1/identity/auth/login',
      { data: { email, password } },
    );
    expect(login.ok()).toBeTruthy();
    const { accessToken } = await login.json();
    const headers = { Authorization: `Bearer ${accessToken}` };

    const created = await request.post(
      'http://127.0.0.1:8080/v1/geodata/refresh-schedules',
      {
        headers: {
          ...headers,
          'Idempotency-Key': randomUUID(),
        },
        data: {
          programmeSlug,
          adapter: 'MANUAL',
          entityTypes: ['SOTA'],
          source: { name: 'Live scheduled snapshot', sourceKey },
          intervalSeconds: 86_400,
          disappearancePolicy: 'REVIEW_REQUIRED',
        },
      },
    );
    const schedule = await created.json();
    expect(created.status()).toBe(201);
    scheduleId = schedule.id as string;
    expect(schedule).toMatchObject({
      programmeSlug,
      adapter: 'MANUAL',
      entityTypes: ['SOTA'],
      source: { name: 'Live scheduled snapshot', sourceKey },
      intervalSeconds: 86_400,
      disappearancePolicy: 'REVIEW_REQUIRED',
      enabled: true,
      lastRunAt: null,
    });

    const listed = await request.get(
      'http://127.0.0.1:8080/v1/geodata/refresh-schedules?page=1&pageSize=100',
      { headers },
    );
    expect(listed.status()).toBe(200);
    expect((await listed.json()).items).toContainEqual(
      expect.objectContaining({ id: scheduleId, programmeSlug }),
    );

    const run = await request.post(
      `http://127.0.0.1:8080/v1/geodata/refresh-schedules/${scheduleId}/run`,
      {
        headers: {
          ...headers,
          'Idempotency-Key': randomUUID(),
        },
        data: { features: [] },
      },
    );
    const queued = await run.json();
    expect(run.status()).toBe(202);
    importRunId = queued.id as string;
    expect(queued).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      queued: true,
      schedule: {
        id: scheduleId,
        lastRunAt: expect.any(String),
        nextRunAt: expect.any(String),
      },
    });

    const deadline = Date.now() + 60_000;
    let importStatus = 'QUEUED';
    const activeStatuses = new Set([
      'QUEUED',
      'PROCESSING',
      'PREPROCESSED',
      'PREPROCESSED_WITH_ERRORS',
    ]);
    while (Date.now() < deadline && activeStatuses.has(importStatus)) {
      const status = await request.get(
        `http://127.0.0.1:8080/v1/geodata/imports/${importRunId}`,
        { headers },
      );
      const statusBody = await status.json();
      expect(status.status()).toBe(200);
      importStatus = statusBody.status as string;
      if (importStatus !== 'COMPLETED')
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(importStatus).toBe('COMPLETED');

    const persisted = await fixture.query<{
      status: string;
      complete_snapshot: boolean;
      disappearance_policy: string;
      programme_slug: string;
      record_count: string;
      queue_status: string;
    }>(
      `SELECT r.status,r.complete_snapshot,r.disappearance_policy,
              r.source_metadata->>'programmeSlug' AS programme_slug,
              m.record_count,
              q.status AS queue_status
       FROM import_run r
       JOIN source_snapshot_manifest m ON m.import_run_id=r.id
       JOIN geodata_import_processing_queue q ON q.import_run_id=r.id
       WHERE r.id=$1::uuid`,
      [importRunId],
    );
    expect(persisted.rows).toEqual([
      {
        status: 'COMPLETED',
        complete_snapshot: true,
        disappearance_policy: 'REVIEW_REQUIRED',
        programme_slug: programmeSlug,
        record_count: '0',
        queue_status: 'COMPLETED',
      },
    ]);

    const savedSchedule = await fixture.query<{ last_run_at: string | null }>(
      `SELECT payload->>'lastRunAt' AS last_run_at
       FROM geodata_control_record WHERE kind='schedules' AND id=$1`,
      [scheduleId],
    );
    expect(savedSchedule.rows).toEqual([{ last_run_at: expect.any(String) }]);
    const snapshotEvents = await fixture.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_event
       WHERE (aggregate_type='refresh_schedule' AND aggregate_id=$1)
          OR (aggregate_type='import_run' AND aggregate_id=$2)
          OR (aggregate_type='import_processing_queue' AND aggregate_id IN
            (SELECT id::text FROM geodata_import_processing_queue
             WHERE import_run_id=$2::uuid))
       ORDER BY event_type`,
      [scheduleId, importRunId],
    );
    expect(snapshotEvents.rows).toEqual([
      { event_type: 'geodata.import.preprocessed.v1' },
      { event_type: 'geodata.import.processing.completed.v1' },
      { event_type: 'geodata.import.processing.queued.v1' },
      { event_type: 'geodata.import.queued.v1' },
      { event_type: 'geodata.refresh-schedule.created.v1' },
    ]);
  } finally {
    try {
      await fixture.query('BEGIN');
      await fixture.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      if (scheduleId)
        await fixture.query(
          `DELETE FROM outbox_event
           WHERE aggregate_type='refresh_schedule' AND aggregate_id=$1`,
          [scheduleId],
        );
      if (importRunId) {
        await fixture.query(
          `DELETE FROM outbox_event
           WHERE (aggregate_type='import_run' AND aggregate_id=$1)
              OR (aggregate_type='import_processing_queue' AND aggregate_id IN
                (SELECT id::text FROM geodata_import_processing_queue
                 WHERE import_run_id=$1::uuid))`,
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
           WHERE service IN ('geodata-schedule-run','geodata-service')
             AND response->>'id'=$1`,
          [importRunId],
        );
      }
      if (scheduleId) {
        await fixture.query(
          "DELETE FROM geodata_control_record WHERE kind='schedules' AND id=$1",
          [scheduleId],
        );
        await fixture.query(
          `DELETE FROM idempotency_record
           WHERE service='geodata-schedule-create' AND response->>'id'=$1`,
          [scheduleId],
        );
      }
      await fixture.query('COMMIT');
    } catch (error) {
      await fixture.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      fixture.release();
      await pool.end();
    }
  }
});
