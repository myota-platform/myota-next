import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../a11y';

test('recalculates broad award progress through the live Admin workflow', async ({
  page,
}) => {
  const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
  test.skip(!databaseUrl, 'requires the isolated Activity parity database');
  if (!databaseUrl) return;

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const fixtureId = randomUUID();
  const awardId = randomUUID();
  const subjectId = `browser-award-subject-${fixtureId}`;
  const awardName = `Broad recalculation ${fixtureId.slice(0, 8)}`;
  let programmeSlug = '';
  let jobId: string | undefined;

  try {
    await page.goto('/awards');
    await expect(page).toHaveURL(/\/login\?redirect=\/awards$/);
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
    await expect(page).toHaveURL(/\/awards$/);
    const programmePicker = page.locator('.programme-scope select');
    await expect(programmePicker).not.toHaveValue('');
    programmeSlug = await programmePicker.inputValue();

    const definition = {
      id: awardId,
      programmeSlug,
      code: `RECALC_${fixtureId.replaceAll('-', '').slice(0, 12)}`,
      name: awardName,
      category: 'ACTIVATOR',
      status: 'PUBLISHED',
      version: 1,
      achievementMetric: 'ACTIVATION_COUNT',
      condition: {
        kind: 'AND',
        conditions: [{ kind: 'ACTIVATION_COUNT', operator: 'GTE', value: 1 }],
      },
      levels: [{ id: 'level-one', name: 'One activation', threshold: 1 }],
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      template: { elements: [] },
    };
    await pool.query(
      `INSERT INTO activity_award_definition
         (id,programme_slug,code,version,status,effective_from,definition)
       VALUES ($1,$2,$3,1,'PUBLISHED',now()-interval '1 minute',$4::jsonb)`,
      [awardId, programmeSlug, definition.code, JSON.stringify(definition)],
    );
    await pool.query(
      `INSERT INTO activity_subject_aggregate
         (programme_slug,subject_id,category,activation_count)
       VALUES ($1,$2,'ACTIVATOR',0)`,
      [programmeSlug, subjectId],
    );

    await page.reload();
    await page
      .getByRole('button', { name: new RegExp(`${awardName}.*PUBLISHED`) })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Participant progress' }),
    ).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept());
    const recalculationButton = page.getByRole('button', {
      name: 'Recalculate all progress',
    });
    const [response] = await Promise.all([
      page.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).pathname ===
            `/v1/awards/${awardId}/recalculation-jobs` &&
          candidate.request().method() === 'POST',
      ),
      (async () => {
        await recalculationButton.focus();
        await page.keyboard.press('Enter');
      })(),
    ]);
    expect(response.status()).toBe(202);
    expect(response.request().headers()['idempotency-key']).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
    expect(response.request().postDataJSON()).toEqual({ subjectIds: [] });
    const created = (await response.json()) as { jobId: string };
    jobId = created.jobId;
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(
      page.getByText('Request accepted; recalculation is queued.'),
    ).toBeVisible();

    await expect
      .poll(
        async () => {
          const result = await pool.query<{ status: string }>(
            'SELECT status FROM activity_job WHERE id=$1::uuid',
            [jobId],
          );
          return result.rows[0]?.status;
        },
        { timeout: 20_000 },
      )
      .toBe('SUCCEEDED');
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await expect(page.getByText('SUCCEEDED', { exact: true })).toBeVisible();
    await expect(page.getByText('Recalculation completed.')).toBeVisible();
    const persisted = await pool.query(
      `SELECT subject_id,category,facts,evaluation
       FROM activity_award_progress
       WHERE award_id=$1::uuid AND award_version=1 AND subject_id=$2`,
      [awardId, subjectId],
    );
    expect(persisted.rows).toHaveLength(1);
    await expectResponsiveAccessible(
      page,
      'Live Admin broad award recalculation completion',
    );
  } finally {
    if (jobId) {
      await pool.query(
        `DELETE FROM outbox_event
         WHERE aggregate_type='activity_job' AND aggregate_id=$1`,
        [jobId],
      );
      await pool.query('DELETE FROM activity_job WHERE id=$1::uuid', [jobId]);
    }
    await pool.query(
      'DELETE FROM activity_award_progress WHERE award_id=$1::uuid',
      [awardId],
    );
    await pool.query(
      'DELETE FROM activity_award_definition WHERE id=$1::uuid',
      [awardId],
    );
    await pool.query(
      `DELETE FROM activity_subject_aggregate
       WHERE programme_slug=$1 AND subject_id=$2`,
      [programmeSlug, subjectId],
    );
    await pool.end();
  }
});
